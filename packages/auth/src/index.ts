import { randomBytes } from "node:crypto";
import { claimBrandwellSidekickInTransaction } from "@brandwell/aimee";
import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import { emailAllowed, parseAllowlist, signupsOpen } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { bearer, organization } from "better-auth/plugins";
import { z } from "zod";

type BrandwellAuthUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
  beforeDeleteUser?: (userId: string) => Promise<void>;
  authenticateBrandwell?: (input: {
    email: string;
    password: string;
  }) => Promise<BrandwellAuthUser>;
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  return betterAuth({
    appName: BRANDWELL_BRAND.fullProductName,
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])],
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: !env.authenticateBrandwell,
      disableSignUp: Boolean(env.authenticateBrandwell) || !signupsOpen(env.signupsEnabled),
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          const memberships = await prisma.member.findMany({
            where: { userId: user.id },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true } } } },
            },
          });
          const personalOrganizationIds = memberships
            .filter(({ organization }) =>
              organization.members.every((member) => member.userId === user.id),
            )
            .map(({ organizationId }) => organizationId);

          await prisma.$transaction([
            prisma.deploymentSettings.updateMany({
              where: { ownerUserId: user.id },
              data: { ownerUserId: null },
            }),
            prisma.organization.deleteMany({
              where: { id: { in: personalOrganizationIds } },
            }),
          ]);
        },
      },
    },
    plugins: [
      bearer(),
      ...(env.authenticateBrandwell ? [brandwellSignIn(env.authenticateBrandwell)] : []),
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
      }),
    ],
    hooks: {
      before: async (ctx) => {
        const path = String((ctx as { path?: string }).path ?? "");
        if (!path.includes("sign-up")) return;
        const allowlist = parseAllowlist(env.signupAllowlist);
        const email =
          typeof ctx.body === "object" && ctx.body && "email" in ctx.body
            ? String((ctx.body as { email?: string }).email ?? "")
            : "";
        if (email && !emailAllowed(email, allowlist)) {
          throw new APIError("BAD_REQUEST", { message: "Email is not allowed to register" });
        }
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const claimedWorkspaceId = await claimBrandwellInvitation(prisma, {
              id: user.id,
              email: user.email,
            });
            if (claimedWorkspaceId) return;
            const orgId = newId();
            await prisma.organization.create({
              data: {
                id: orgId,
                name: "Personal",
                slug: `user-${user.id.slice(0, 12)}`,
                createdAt: new Date(),
              },
            });
            await prisma.member.create({
              data: {
                id: newId(),
                organizationId: orgId,
                userId: user.id,
                role: "owner",
                createdAt: new Date(),
              },
            });
            const existing = await prisma.deploymentSettings.findUnique({
              where: { id: "default" },
            });
            if (!existing) {
              await prisma.deploymentSettings.create({
                data: { id: "default", ownerUserId: user.id },
              });
            } else if (!existing.ownerUserId) {
              await prisma.deploymentSettings.update({
                where: { id: "default" },
                data: { ownerUserId: user.id },
              });
            }
            await prisma.memoryDocument.create({
              data: {
                workspaceId: orgId,
                userId: user.id,
                scope: "user",
                path: "MEMORY.md",
                content: "# User memory\n\nAccount-wide preferences live here.\n",
              },
            });
            await prisma.notificationPreference.create({
              data: {
                workspaceId: orgId,
                userId: user.id,
              },
            });
          },
        },
      },
    },
  });
}

function brandwellSignIn(authenticate: NonNullable<AuthEnv["authenticateBrandwell"]>) {
  return {
    id: "brandwell-sign-in",
    endpoints: {
      signInBrandwell: createAuthEndpoint(
        "/sign-in/brandwell",
        {
          method: "POST",
          body: z.object({
            email: z.string().email().max(254),
            password: z.string().min(1).max(128),
            rememberMe: z.boolean().optional(),
          }),
        },
        async (ctx) => {
          let user: BrandwellAuthUser;
          try {
            user = await authenticate({ email: ctx.body.email, password: ctx.body.password });
          } catch (error) {
            const details = managedAuthError(error);
            throw new APIError(details.status, {
              message: details.message,
              code: details.code,
            });
          }
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            ctx.body.rememberMe === false,
          );
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "AIMEE could not create a session.",
              code: "aimee_session_failed",
            });
          }
          await setSessionCookie(ctx, { session, user }, ctx.body.rememberMe === false);
          return ctx.json({
            redirect: false,
            token: session.token,
            user,
          });
        },
      ),
    },
  };
}

function managedAuthError(error: unknown) {
  const candidate = error as { message?: unknown; code?: unknown; statusCode?: unknown };
  const statusCode = Number(candidate?.statusCode || 500);
  const statuses = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    402: "PAYMENT_REQUIRED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    502: "BAD_GATEWAY",
    503: "SERVICE_UNAVAILABLE",
  } as const;
  return {
    status: statuses[statusCode as keyof typeof statuses] || "INTERNAL_SERVER_ERROR",
    message:
      typeof candidate?.message === "string" && candidate.message.trim()
        ? candidate.message
        : "BrandWell sign-in failed.",
    code: typeof candidate?.code === "string" ? candidate.code : "brandwell_auth_failed",
  };
}

export async function claimBrandwellInvitation(
  prisma: PrismaClient,
  user: { id: string; email: string },
  now = new Date(),
): Promise<string | null> {
  const invitations = await prisma.invitation.findMany({
    where: {
      email: user.email.trim().toLowerCase(),
      status: "pending",
      expiresAt: { gt: now },
    },
    include: {
      organization: {
        select: { brandwellWorkspace: { select: { id: true } } },
      },
    },
    orderBy: [{ expiresAt: "desc" }, { id: "asc" }],
  });
  const invitation = invitations.find((candidate) => candidate.organization.brandwellWorkspace);
  if (!invitation) return null;

  await prisma.$transaction(async (tx) => {
    await tx.member.upsert({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId: user.id,
        },
      },
      create: {
        id: newId(),
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role || "owner",
        createdAt: now,
      },
      update: { role: invitation.role || "owner" },
    });
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "accepted" },
    });
    await claimBrandwellSidekickInTransaction(tx, {
      workspaceId: invitation.organizationId,
      userId: user.id,
      email: user.email,
      now,
    });
    const memory = await tx.memoryDocument.findFirst({
      where: {
        workspaceId: invitation.organizationId,
        userId: user.id,
        scope: "user",
        botId: null,
        path: "MEMORY.md",
      },
      select: { id: true },
    });
    if (!memory) {
      await tx.memoryDocument.create({
        data: {
          workspaceId: invitation.organizationId,
          userId: user.id,
          scope: "user",
          path: "MEMORY.md",
          content: "# User memory\n\nAccount-wide preferences live here.\n",
        },
      });
    }
    await tx.notificationPreference.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: invitation.organizationId,
          userId: user.id,
        },
      },
      create: { workspaceId: invitation.organizationId, userId: user.id },
      update: {},
    });
  });

  return invitation.organizationId;
}

export type Auth = ReturnType<typeof createAuth>;

export const blockedAuthPaths = [
  "/organization/create",
  "/organization/invite",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
];
