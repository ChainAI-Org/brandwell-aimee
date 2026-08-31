import type { BrandwellPlatformIdentity } from "@brandwell/aimee";

export class BrandwellPlatformAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BrandwellPlatformAuthError";
  }
}

export class BrandwellPlatformAuthClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly serviceToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async authenticate(email: string, password: string): Promise<BrandwellPlatformIdentity> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/internal/aimee/authenticate-user`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new BrandwellPlatformAuthError(
        "BrandWell sign-in is temporarily unavailable.",
        "brandwell_auth_unavailable",
        503,
      );
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = responseError(body);
      throw new BrandwellPlatformAuthError(error.message, error.code, response.status);
    }
    if (!isPlatformIdentity(body)) {
      throw new BrandwellPlatformAuthError(
        "BrandWell returned an invalid AIMEE access response.",
        "brandwell_auth_invalid_response",
        502,
      );
    }
    return body;
  }
}

function responseError(body: unknown) {
  if (!body || typeof body !== "object") {
    return { message: "BrandWell sign-in failed.", code: "brandwell_auth_failed" };
  }
  const value = body as { error?: unknown; message?: unknown; code?: unknown };
  return {
    message:
      typeof value.message === "string"
        ? value.message
        : typeof value.error === "string"
          ? value.error
          : "BrandWell sign-in failed.",
    code: typeof value.code === "string" ? value.code : "brandwell_auth_failed",
  };
}

function isPlatformIdentity(value: unknown): value is BrandwellPlatformIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<BrandwellPlatformIdentity>;
  const user = identity.user;
  const access = identity.access;
  return Boolean(
    user &&
      typeof user.id === "string" &&
      typeof user.agencyId === "string" &&
      typeof user.clientId === "string" &&
      typeof user.name === "string" &&
      typeof user.email === "string" &&
      access &&
      (access.kind === "master" || access.kind === "sidekick") &&
      typeof access.brandwellCustomerId === "string" &&
      typeof access.workspaceId === "string" &&
      (typeof access.sidekickId === "string" || access.sidekickId === null),
  );
}
