import { createHmac } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { z } from "zod";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const ACTIVE_SUBSCRIPTIONS = new Set(["active", "trialing"]);

const IcpsSchema = z
  .object({
    roles: z.array(z.string().min(1).max(160)).max(50).optional(),
    seniorities: z.array(z.string().min(1).max(80)).max(30).optional(),
    industries: z.array(z.string().min(1).max(160)).max(50).optional(),
    locations: z.array(z.string().min(1).max(160)).max(50).optional(),
    employee_min: z.number().int().nonnegative().optional(),
    employee_max: z.number().int().positive().optional(),
    revenue_min: z.number().nonnegative().optional(),
    revenue_max: z.number().positive().optional(),
  })
  .strict()
  .optional();

const PaginationSchema = {
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
};
const CampaignReferenceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,120}$/, "Campaign reference is invalid");

const ToolDefinitions = [
  {
    name: "brandwell_intent_search",
    description:
      "Search this client's BrandWell buyer-intent topics and profiles. Results are limited to the current workspace.",
    readOnly: true,
    endpoint: "/internal/aimee/intent/search",
    schema: z
      .object({
        query: z.string().min(1).max(500),
        saved_icp_id: z.string().min(1).max(200).optional(),
        icp: IcpsSchema,
        ...PaginationSchema,
      })
      .strict(),
  },
  {
    name: "brandwell_intent_get_daily_buyers",
    description:
      "Get the newest in-market buyers for this client's saved topics, optionally narrowed by an ICP.",
    readOnly: true,
    endpoint: "/internal/aimee/intent/daily-buyers",
    schema: z
      .object({
        topic_id: z.string().min(1).max(200).optional(),
        saved_icp_id: z.string().min(1).max(200).optional(),
        icp: IcpsSchema,
        ...PaginationSchema,
      })
      .strict(),
  },
  {
    name: "brandwell_trafficid_get_visitors",
    description:
      "Get identified website visitors for this client, including visit activity and allowed contact fields.",
    readOnly: true,
    endpoint: "/internal/aimee/trafficid/visitors",
    schema: z
      .object({
        website_id: z.string().min(1).max(200).optional(),
        since: z.string().datetime({ offset: true }).optional(),
        saved_icp_id: z.string().min(1).max(200).optional(),
        icp: IcpsSchema,
        ...PaginationSchema,
      })
      .strict(),
  },
  {
    name: "brandwell_trafficid_qualify_visitor",
    description:
      "Score one identified visitor against this client's saved ICP. This does not send outreach or mail.",
    readOnly: true,
    endpoint: "/internal/aimee/trafficid/qualify",
    schema: z
      .object({
        visitor_id: z.string().min(1).max(200),
        saved_icp_id: z.string().min(1).max(200).optional(),
        icp: IcpsSchema,
      })
      .strict(),
  },
  {
    name: "brandwell_postcards_create_campaign_draft",
    description:
      "Create an editable postcard campaign draft for this client. It cannot charge, print, mail, or activate the campaign. Manual and TrafficID campaigns default to daily batches. Intent campaigns default to the plan's included Market Refresh cadence.",
    readOnly: false,
    endpoint: "/internal/aimee/postcards/campaigns/draft",
    schema: z
      .object({
        name: z.string().min(1).max(200),
        source: z.enum(["manual", "trafficid", "intent"]),
        source_id: z.string().min(1).max(200).optional(),
        saved_icp_id: z.string().min(1).max(200).optional(),
        icp: IcpsSchema,
        cadence: z.enum(["daily", "weekly", "every_other_day", "one_time"]).optional(),
        timezone: z.string().min(1).max(100).optional(),
        scheduled_start_at: z.string().datetime({ offset: true }).optional(),
        max_per_run: z.number().int().min(1).max(50_000).optional(),
        monthly_budget_cents: z.number().int().min(100).max(100_000_000).optional(),
        duplicate_policy: z.enum(["days", "never"]).default("days"),
        duplicate_window_days: z.number().int().min(1).max(3_650).default(90),
        creative_id: z.string().min(1).max(200).optional(),
      })
      .strict(),
  },
  {
    name: "brandwell_postcards_list_campaigns",
    description:
      "List this client's postcard campaigns so an existing manual queue can be selected by name, status, source, and schedule. Open campaigns are returned by default.",
    readOnly: true,
    endpoint: "/internal/aimee/postcards/campaigns/list",
    schema: z
      .object({
        status: z.enum(["draft", "active", "paused", "completed", "cancelled"]).optional(),
        source: z.enum(["manual", "trafficid", "intent"]).optional(),
        include_closed: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
      })
      .strict(),
  },
  {
    name: "brandwell_postcards_update_campaign_settings",
    description:
      "Configure the schedule and safety settings of this client's draft or paused postcard campaign. This cannot activate, charge, print, or mail the campaign.",
    readOnly: false,
    endpoint: "/internal/aimee/postcards/campaigns/:campaignId/settings",
    schema: z
      .object({
        campaign_id: CampaignReferenceSchema,
        name: z.string().min(1).max(200).optional(),
        cadence: z.enum(["daily", "weekly", "every_other_day", "one_time"]).optional(),
        timezone: z.string().min(1).max(100).optional(),
        scheduled_start_at: z.string().datetime({ offset: true }).optional(),
        max_per_run: z.number().int().min(1).max(50_000).optional(),
        monthly_budget_cents: z.number().int().min(100).max(100_000_000).optional(),
        duplicate_policy: z.enum(["days", "never"]).optional(),
        duplicate_window_days: z.number().int().min(1).max(3_650).optional(),
      })
      .strict()
      .refine(
        (input) => Object.keys(input).some((key) => key !== "campaign_id"),
        "At least one campaign setting is required",
      ),
  },
  {
    name: "brandwell_postcards_queue_recipients",
    description:
      "Add manually supplied or enriched people to an open manual postcard campaign. Drafts still require human approval. Active campaigns process new recipients only in their next authorized scheduled batch, with account suppression, address, duplicate, and budget gates.",
    readOnly: false,
    endpoint: "/internal/aimee/postcards/campaigns/:campaignId/recipients",
    schema: z
      .object({
        campaign_id: CampaignReferenceSchema,
        recipients: z
          .array(
            z
              .object({
                external_id: z.string().max(200).optional(),
                first_name: z.string().max(120).optional(),
                last_name: z.string().max(120).optional(),
                title: z.string().max(200).optional(),
                company: z.string().max(200).optional(),
                email: z.string().email().max(320).optional(),
                phone: z.string().max(80).optional(),
                address_line_1: z.string().max(240).optional(),
                address_line_2: z.string().max(240).optional(),
                city: z.string().max(160).optional(),
                state: z.string().max(80).optional(),
                postal_code: z.string().max(40).optional(),
                country: z.string().max(80).default("US"),
                personalization: z.record(z.string(), z.string().max(1_000)).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
  },
  {
    name: "brandwell_postcards_get_status",
    description:
      "Get this client's postcard campaign status, queued recipients, delivery, QR scans, identified visitors, and attribution totals.",
    readOnly: true,
    endpoint: "/internal/aimee/postcards/campaigns/status",
    schema: z
      .object({
        campaign_id: CampaignReferenceSchema,
        include_recipients: z.boolean().default(false),
        ...PaginationSchema,
      })
      .strict(),
  },
] as const;

type ToolDefinition = (typeof ToolDefinitions)[number];

export type BrandwellNativeConnectorConfig = {
  apiBaseUrl: string;
  serviceToken: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

export class BrandwellNativeConnector implements ConnectorProvider {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaClient,
    config: BrandwellNativeConnectorConfig,
  ) {
    this.baseUrl = validatedBaseUrl(config.apiBaseUrl);
    this.serviceToken = config.serviceToken.trim();
    if (this.serviceToken.length < 32) {
      throw new Error("BrandWell platform service token must be at least 32 characters");
    }
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? (() => new Date());
  }

  describe() {
    return {
      id: "brandwell-native",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    if (!(await this.resolveScope(context))) return [];
    return ToolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema) as Record<string, unknown>,
      readOnly: tool.readOnly,
      route: { connectorId: "brandwell-native", toolName: tool.name },
    }));
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const scope = await this.resolveScope(context);
    if (!scope) {
      yield { type: "error", message: "BrandWell tools are unavailable for this workspace" };
      return;
    }
    const definition = ToolDefinitions.find((tool) => tool.name === call.tool);
    if (!definition) {
      yield { type: "error", message: "Unknown BrandWell tool" };
      return;
    }
    try {
      const parsed = definition.schema.parse(call.args) as Record<string, unknown>;
      const { endpoint, body } = requestFor(definition, parsed);
      const serialized = JSON.stringify({
        ...body,
        ...(definition.readOnly ? {} : { agent_intake_source: "aimee" }),
      });
      const timestamp = this.now().toISOString();
      const signature = createHmac("sha256", this.serviceToken)
        .update(
          `${timestamp}.${scope.brandwellCustomerId}.${context.workspaceId}.${call.executionId}.${serialized}`,
        )
        .digest("hex");
      const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          "content-type": "application/json",
          "x-brandwell-customer-id": scope.brandwellCustomerId,
          "x-brandwell-workspace-id": context.workspaceId,
          "x-brandwell-service-identity-id": context.serviceIdentityId!,
          "x-brandwell-execution-id": call.executionId,
          "x-brandwell-timestamp": timestamp,
          "x-brandwell-signature": signature,
          ...(!definition.readOnly
            ? { "x-brandwell-idempotency-key": `${context.workspaceId}:${call.executionId}` }
            : {}),
        },
        body: serialized,
        signal: combineSignals(context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
      });
      if (!response.ok) {
        yield {
          type: "error",
          message: `BrandWell request failed with status ${response.status}`,
        };
        return;
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > MAX_RESPONSE_BYTES) {
        yield { type: "error", message: "BrandWell response exceeded the safe size limit" };
        return;
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        yield { type: "error", message: "BrandWell response exceeded the safe size limit" };
        return;
      }
      const data = text ? JSON.parse(text) : { ok: true };
      yield { type: "result", data: redactConnectorPayload(data, [this.serviceToken]) };
    } catch (error) {
      yield {
        type: "error",
        message: sanitizeConnectorError(error, [this.serviceToken]),
      };
    }
  }

  private async resolveScope(context: AdapterContext) {
    if (!context.serviceIdentityId) return null;
    const [mapping, identity] = await Promise.all([
      this.prisma.brandwellAiWorkspace.findUnique({
        where: { rakazoWorkspaceId: context.workspaceId },
        select: {
          brandwellCustomerId: true,
          subscriptionStatus: true,
          serviceIdentityId: true,
        },
      }),
      this.prisma.brandwellServiceIdentity.findUnique({
        where: { id: context.serviceIdentityId },
        select: { workspaceId: true, status: true },
      }),
    ]);
    if (
      !mapping ||
      !identity ||
      !ACTIVE_SUBSCRIPTIONS.has(mapping.subscriptionStatus) ||
      identity.status !== "active" ||
      identity.workspaceId !== context.workspaceId ||
      mapping.serviceIdentityId !== context.serviceIdentityId
    ) {
      return null;
    }
    return { brandwellCustomerId: mapping.brandwellCustomerId };
  }
}

function requestFor(
  definition: ToolDefinition,
  parsed: Record<string, unknown>,
): { endpoint: string; body: Record<string, unknown> } {
  if (definition.name === "brandwell_postcards_queue_recipients") {
    const campaignId = String(parsed.campaign_id);
    const { campaign_id: _campaignId, ...body } = parsed;
    return {
      endpoint: definition.endpoint.replace(":campaignId", encodeURIComponent(campaignId)),
      body: { ...body, intake_source: "agent" },
    };
  }
  if (definition.name === "brandwell_postcards_update_campaign_settings") {
    const campaignId = String(parsed.campaign_id);
    const { campaign_id: _campaignId, ...body } = parsed;
    return {
      endpoint: definition.endpoint.replace(":campaignId", encodeURIComponent(campaignId)),
      body,
    };
  }
  return { endpoint: definition.endpoint, body: parsed };
}

function validatedBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("BrandWell platform API URL must use HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}
