import { createHash, createHmac } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { BrandwellNativeConnector } from "./brandwell-native-connector.js";

const SERVICE_TOKEN = "service-token-for-tests-0123456789abcdef";

function expectedSignature(
  endpoint: string,
  serialized: string,
  timestamp: string,
  idempotencyKey = "",
) {
  const requestHash = createHash("sha256").update(serialized).digest("hex");
  return createHmac("sha256", SERVICE_TOKEN)
    .update(
      [
        "brandwell-aimee-signature:v1",
        "POST",
        endpoint,
        "customer-acme",
        "workspace-acme",
        "service-acme",
        "effect-1",
        idempotencyKey,
        timestamp,
        requestHash,
      ].join("\n"),
    )
    .digest("hex");
}

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    operationId: "operation-1",
    traceId: "trace-1",
    workspaceId: "workspace-acme",
    userId: "system-user",
    serviceIdentityId: "service-acme",
    botId: "bot-aimee",
    runId: "run-1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function activePrisma() {
  return {
    brandwellAiWorkspace: {
      findUnique: vi.fn(async () => ({
        brandwellCustomerId: "customer-acme",
        subscriptionStatus: "active",
        serviceIdentityId: "service-acme",
      })),
    },
    brandwellServiceIdentity: {
      findUnique: vi.fn(async () => ({
        workspaceId: "workspace-acme",
        status: "active",
      })),
    },
  } as unknown as PrismaClient;
}

async function eventsFrom(
  connector: BrandwellNativeConnector,
  tool: string,
  args: Record<string, unknown>,
) {
  const events = [];
  for await (const event of connector.execute({ tool, args, executionId: "effect-1" }, context())) {
    events.push(event);
  }
  return events;
}

describe("BrandWell native connector", () => {
  it("binds SocialStreams reads to the signed project endpoint", async () => {
    let sent: RequestInit | undefined;
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: async (_url, init) => {
        sent = init;
        return new Response(JSON.stringify({ records: [] }));
      },
    });
    expect(
      await eventsFrom(connector, "brandwell_socialstreams_get_opportunities", {
        record_type: "job",
        unclaimed: true,
      }),
    ).toEqual([{ type: "result", data: { records: [] } }]);
    expect(JSON.parse(String(sent?.body))).toEqual({
      tool: "get_social_opportunities",
      arguments: { record_type: "job", unclaimed: true, limit: 25 },
    });
    expect(sent?.headers).toHaveProperty("x-brandwell-signature");
  });
  it("requires a strong control-plane service token", () => {
    expect(
      () =>
        new BrandwellNativeConnector(activePrisma(), {
          apiBaseUrl: "https://portal.example.test",
          serviceToken: "short",
        }),
    ).toThrow("at least 32 characters");
  });

  it("only exposes tools to the active workspace service identity", async () => {
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
    });
    expect(await connector.discoverTools(context({ serviceIdentityId: undefined }))).toEqual([]);

    const tools = await connector.discoverTools(context());
    expect(tools.map((tool) => tool.name)).toContain("brandwell_postcards_list_campaigns");
    expect(tools.map((tool) => tool.name)).toContain(
      "brandwell_postcards_update_campaign_settings",
    );
    expect(tools.map((tool) => tool.name)).toContain("brandwell_postcards_queue_recipients");
    expect(tools.find((tool) => tool.name === "brandwell_trafficid_get_visitors")?.readOnly).toBe(
      true,
    );
    expect(tools.find((tool) => tool.name === "brandwell_visibility_get_overview")?.readOnly).toBe(
      true,
    );
    expect(
      tools.find((tool) => tool.name === "brandwell_visibility_get_domain_overview")?.readOnly,
    ).toBe(false);
    expect(tools.filter((tool) => tool.name.startsWith("brandwell_visibility_"))).toHaveLength(23);
    expect(tools.filter((tool) => tool.name.startsWith("brandwell_rankwell_"))).toHaveLength(9);
    expect(tools.find((tool) => tool.name === "brandwell_rankwell_get_strategy")?.readOnly).toBe(
      true,
    );
    expect(
      tools.find((tool) => tool.name === "brandwell_rankwell_generate_article")?.readOnly,
    ).toBe(false);
  });

  it("routes visibility reads through the signed cached-data endpoint", async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return new Response(JSON.stringify({ search_console: { status: "ready" } }));
      },
      now: () => new Date("2026-08-30T17:00:00.000Z"),
    });

    const events = await eventsFrom(connector, "brandwell_visibility_get_search_console", {
      limit: 50,
      include_daily: false,
    });

    expect(events).toEqual([{ type: "result", data: { search_console: { status: "ready" } } }]);
    expect(requestUrl).toBe("https://portal.example.test/internal/aimee/visibility/read");
    expect(requestInit?.headers).not.toHaveProperty("x-brandwell-idempotency-key");
    const serialized = String(requestInit?.body);
    const headers = requestInit?.headers as Record<string, string>;
    expect(headers["x-brandwell-signature-version"]).toBe("v1");
    expect(headers["x-brandwell-signature"]).toBe(
      expectedSignature("/internal/aimee/visibility/read", serialized, "2026-08-30T17:00:00.000Z"),
    );
    expect(JSON.parse(serialized)).toEqual({
      tool: "get_search_console_performance",
      arguments: { limit: 50, include_daily: false },
    });
  });

  it("routes project-budgeted visibility research through an idempotent signed endpoint", async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return new Response(JSON.stringify({ domain_overview: { domain: "competitor.example" } }));
      },
      now: () => new Date("2026-08-30T17:00:00.000Z"),
    });

    const events = await eventsFrom(connector, "brandwell_visibility_get_domain_overview", {
      domain: "competitor.example",
    });

    expect(events).toEqual([
      {
        type: "result",
        data: { domain_overview: { domain: "competitor.example" } },
      },
    ]);
    expect(requestUrl).toBe("https://portal.example.test/internal/aimee/visibility/research");
    expect(requestInit?.headers).toMatchObject({
      "x-brandwell-idempotency-key": "workspace-acme:effect-1",
    });
    const serialized = String(requestInit?.body);
    const headers = requestInit?.headers as Record<string, string>;
    expect(JSON.parse(serialized)).toEqual({
      tool: "get_domain_overview",
      arguments: { domain: "competitor.example" },
      agent_intake_source: "aimee",
    });
    expect(headers["x-brandwell-signature"]).toBe(
      expectedSignature(
        "/internal/aimee/visibility/research",
        serialized,
        "2026-08-30T17:00:00.000Z",
        "workspace-acme:effect-1",
      ),
    );
  });

  it("forwards an explicitly approved AI citation refresh confirmation", async () => {
    let requestInit: RequestInit | undefined;
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: async (_url, init) => {
        requestInit = init;
        return new Response(JSON.stringify({ ai_citations: { total_mentions: 12 } }));
      },
    });

    const events = await eventsFrom(connector, "brandwell_visibility_get_ai_citations", {
      query: "brandwell.ai",
      confirmed_cost_usd: 0.2,
    });

    expect(events).toEqual([{ type: "result", data: { ai_citations: { total_mentions: 12 } } }]);
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      tool: "get_ai_citations",
      arguments: { query: "brandwell.ai", confirmed_cost_usd: 0.2 },
      agent_intake_source: "aimee",
    });
  });

  it("queues RankWell writing with a deterministic retry key through the signed project endpoint", async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return new Response(
          JSON.stringify({
            job: { id: "job-1", article_id: "article-1", status: "queued" },
          }),
        );
      },
      now: () => new Date("2026-08-30T17:00:00.000Z"),
    });

    const events = await eventsFrom(connector, "brandwell_rankwell_generate_article", {
      keyword: "intent marketing platform",
      title: "Intent Marketing Platform Guide",
    });

    expect(events).toEqual([
      {
        type: "result",
        data: {
          job: { id: "job-1", article_id: "article-1", status: "queued" },
        },
      },
    ]);
    expect(requestUrl).toBe("https://portal.example.test/internal/aimee/visibility/research");
    expect(requestInit?.headers).toMatchObject({
      "x-brandwell-idempotency-key": "workspace-acme:effect-1",
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      tool: "generate_rankwell_article",
      arguments: {
        keyword: "intent marketing platform",
        title: "Intent Marketing Platform Guide",
        request_key: `aimee:${createHash("sha256").update("workspace-acme:effect-1").digest("hex")}`,
      },
      agent_intake_source: "aimee",
    });
  });

  it("tracks a queued article through scoped read tools without starting more paid work", async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({
          body,
          headers: init?.headers as Record<string, string>,
        });
        return Response.json(
          body.tool === "list_rankwell_generation_jobs"
            ? {
                jobs: [
                  {
                    id: "job-1",
                    article_id: "article-1",
                    status: "running",
                    phase: "writing",
                  },
                ],
              }
            : {
                job: {
                  id: "job-1",
                  article_id: "article-1",
                  status: "completed",
                  phase: "completed",
                },
              },
        );
      },
    });
    const listed = await eventsFrom(connector, "brandwell_rankwell_list_generation_jobs", {
      limit: 10,
    });
    const finished = await eventsFrom(connector, "brandwell_rankwell_get_generation_job", {
      job_id: "job-1",
    });
    expect(listed).toMatchObject([{ type: "result", data: { jobs: [{ phase: "writing" }] } }]);
    expect(finished).toMatchObject([
      {
        type: "result",
        data: { job: { article_id: "article-1", status: "completed" } },
      },
    ]);
    expect(requests.map((request) => request.body.tool)).toEqual([
      "list_rankwell_generation_jobs",
      "get_rankwell_generation_job",
    ]);
    for (const request of requests) {
      expect(request.headers["x-brandwell-workspace-id"]).toBe("workspace-acme");
      expect(request.headers).not.toHaveProperty("x-brandwell-idempotency-key");
    }
  });

  it("preserves explicit retry identity and article options and rejects unsupported options before dispatch", async () => {
    const bodies: Record<string, unknown>[] = [];
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json(
          {
            job: { id: "job-retry", article_id: "article-1", status: "queued" },
          },
          { status: 202 },
        );
      },
    });
    const args = {
      article_id: "article-1",
      request_key: "approved-retry-001",
      article_options: { feature_image: true, word_count: 1800 },
    };
    await eventsFrom(connector, "brandwell_rankwell_generate_article", args);
    await eventsFrom(connector, "brandwell_rankwell_generate_article", args);
    expect(bodies[0]?.arguments).toEqual(args);
    expect(bodies[1]).toEqual(bodies[0]);
    for (const invalid of [
      { request_key: "short" },
      { article_options: { deep_research: true } },
      { article_options: { publish: true } },
    ]) {
      const events = await eventsFrom(connector, "brandwell_rankwell_generate_article", {
        ...args,
        ...invalid,
      });
      expect(events.some((event) => event.type === "error")).toBe(true);
    }
    expect(bodies).toHaveLength(2);
  });

  it("scopes recipient intake in headers and forces agent draft intake", async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return new Response(JSON.stringify({ ok: true, queued: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test/",
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    });

    const events = await eventsFrom(connector, "brandwell_postcards_queue_recipients", {
      campaign_id: "campaign-acme",
      recipients: [
        {
          first_name: "Alex",
          last_name: "Buyer",
          email: "alex@example.com",
          address_line_1: "100 Main St",
          city: "Phoenix",
          state: "AZ",
          postal_code: "85001",
        },
      ],
    });

    expect(events).toEqual([{ type: "result", data: { ok: true, queued: 1 } }]);
    expect(requestUrl).toBe(
      "https://portal.example.test/internal/aimee/postcards/campaigns/campaign-acme/recipients",
    );
    expect(requestInit?.headers).toMatchObject({
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-brandwell-customer-id": "customer-acme",
      "x-brandwell-workspace-id": "workspace-acme",
      "x-brandwell-service-identity-id": "service-acme",
      "x-brandwell-idempotency-key": "workspace-acme:effect-1",
      "x-brandwell-signature-version": "v1",
    });
    const serialized = String(requestInit?.body);
    const headers = requestInit?.headers as Record<string, string>;
    expect(headers["x-brandwell-signature"]).toBe(
      expectedSignature(
        "/internal/aimee/postcards/campaigns/campaign-acme/recipients",
        serialized,
        "2026-08-27T12:00:00.000Z",
        "workspace-acme:effect-1",
      ),
    );
    expect(JSON.parse(serialized)).toMatchObject({
      intake_source: "agent",
      agent_intake_source: "aimee",
      recipients: [{ email: "alex@example.com" }],
    });
  });

  it("delegates source-aware cadence and defaults duplicate protection to 90 days", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ id: "campaign-1" }));
    };
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
    });

    await eventsFrom(connector, "brandwell_postcards_create_campaign_draft", {
      name: "Daily identified visitors",
      source: "trafficid",
    });

    const body = JSON.parse(String(requestInit?.body));
    expect(body).toMatchObject({
      duplicate_policy: "days",
      duplicate_window_days: 90,
      agent_intake_source: "aimee",
    });
    expect(body).not.toHaveProperty("cadence");
  });

  it("forwards a configured batch start for new campaign drafts", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ id: "campaign-1" }));
    };
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
    });

    await eventsFrom(connector, "brandwell_postcards_create_campaign_draft", {
      name: "Daily enriched prospects",
      source: "manual",
      scheduled_start_at: "2026-08-28T09:30:00-07:00",
    });

    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      scheduled_start_at: "2026-08-28T09:30:00-07:00",
      agent_intake_source: "aimee",
    });
  });

  it("updates only a scoped draft schedule and never exposes activation", async () => {
    let requestUrl: string | URL | Request | undefined;
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return new Response(JSON.stringify({ schedule_updated: true, agent_can_activate: false }));
    };
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
    });

    const events = await eventsFrom(connector, "brandwell_postcards_update_campaign_settings", {
      campaign_id: "campaign-acme",
      cadence: "daily",
      max_per_run: 125,
      duplicate_policy: "days",
      duplicate_window_days: 90,
    });

    expect(events).toEqual([
      {
        type: "result",
        data: { schedule_updated: true, agent_can_activate: false },
      },
    ]);
    expect(requestUrl).toBe(
      "https://portal.example.test/internal/aimee/postcards/campaigns/campaign-acme/settings",
    );
    expect(requestInit?.headers).toMatchObject({
      "x-brandwell-idempotency-key": "workspace-acme:effect-1",
    });
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      cadence: "daily",
      max_per_run: 125,
      duplicate_policy: "days",
      duplicate_window_days: 90,
      agent_intake_source: "aimee",
    });
    expect(JSON.parse(String(requestInit?.body))).not.toHaveProperty("campaign_id");
  });

  it("never returns an upstream error body or service token", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(`${SERVICE_TOKEN} internal stack and customer data`, {
          status: 500,
        }),
    );
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
    });
    const events = await eventsFrom(connector, "brandwell_postcards_get_status", {
      campaign_id: "campaign-1",
    });
    expect(events).toEqual([
      { type: "error", message: "BrandWell request failed with status 500" },
    ]);
  });

  it("turns the known research confirmation response into safe agent guidance", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "This request needs confirmation before it can run.",
            code: "SEO_RESEARCH_CONFIRMATION_REQUIRED",
            internal: SERVICE_TOKEN,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    const connector = new BrandwellNativeConnector(activePrisma(), {
      apiBaseUrl: "https://portal.example.test",
      serviceToken: SERVICE_TOKEN,
      fetch: fetchImpl,
    });

    const events = await eventsFrom(connector, "brandwell_visibility_get_ai_citations", {
      query: "brandwell.ai",
    });

    expect(events).toEqual([
      {
        type: "error",
        message:
          "A fresh BrandWell visibility lookup requires explicit user approval before it can run.",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(SERVICE_TOKEN);
  });
});
