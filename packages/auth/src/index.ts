import { randomBytes } from "node:crypto";
import { BRANDWELL_BRAND } from "@brandwell/aimee/brand-config";
import { emailAllowed, parseAllowlist, signupsOpen } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
  beforeDeleteUser?: (userId: string) => Promise<void>;
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
      enabled: true,
      disableSignUp: !signupsOpen(env.signupsEnabled),
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
