import { createHash, createHmac } from "node:crypto";
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
const SIGNATURE_VERSION = "v1";
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
    name: "brandwell_visibility_get_project",
    description: "Read the Company Project and canonical domain bound to this AIMEE workspace.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "whoami",
    schema: z.object({}).strict(),
  },
  {
    name: "brandwell_visibility_get_overview",
    description:
      "Read stored domain and AI visibility snapshots for this Company Project. This never refreshes a provider.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_visibility_overview",
    schema: z.object({}).strict(),
  },
  {
    name: "brandwell_visibility_get_search_console",
    description:
      "Read stored Search Console metrics, queries, pages, and opportunities for this Company Project.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_search_console_performance",
    schema: z
      .object({
        limit: z.number().int().min(1).max(100).default(25),
        include_daily: z.boolean().default(true),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_get_content_opportunities",
    description:
      "Rank existing pages with Search Console striking-distance or click-through opportunities.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_content_opportunities",
    schema: z.object({ limit: z.number().int().min(1).max(100).default(25) }).strict(),
  },
  {
    name: "brandwell_visibility_get_cannibalization_candidates",
    description:
      "Find Search Console queries that received impressions for multiple project URLs. Results require intent review before any merge or redirect.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_cannibalization_candidates",
    schema: z.object({ limit: z.number().int().min(1).max(100).default(25) }).strict(),
  },
  {
    name: "brandwell_visibility_get_analytics",
    description:
      "Read the stored Google Analytics summary, daily metrics, and acquisition rows for this Company Project.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_analytics_summary",
    schema: z
      .object({
        limit: z.number().int().min(1).max(50).default(10),
        include_daily: z.boolean().default(true),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_list_saved_keywords",
    description:
      "List saved keyword opportunities for this Company Project from BrandWell storage.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "list_saved_keywords",
    schema: z
      .object({
        status: z.enum(["candidate", "tracked", "dismissed"]).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_get_rank_tracking",
    description:
      "Read the latest stored rank tracking results for this Company Project. This never runs a rank check.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_rank_tracking",
    schema: z.object({}).strict(),
  },
  {
    name: "brandwell_visibility_list_site_audits",
    description: "List stored site audit runs for this Company Project. This never starts a crawl.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "list_site_audits",
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
  },
  {
    name: "brandwell_visibility_get_site_audit",
    description: "Read pages and Lighthouse results from one stored Company Project site audit.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_site_audit",
    schema: z.object({ audit_id: z.string().min(1).max(80) }).strict(),
  },
  {
    name: "brandwell_visibility_get_domain_overview",
    description:
      "Research the organic footprint and link authority of the project domain or another domain. Results are cached for 24 hours and may use the project's research allowance on a cache miss.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "get_domain_overview",
    timeoutMs: 60_000,
    schema: z
      .object({
        domain: z.string().min(1).max(500).optional(),
        location_code: z.number().int().positive().optional(),
        language_code: z.string().min(2).max(16).optional(),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_get_domain_keywords",
    description:
      "Research the ranked keywords and landing pages for the project domain or another domain. Results are cached for 24 hours and may use the project's research allowance on a cache miss.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "get_domain_keywords",
    timeoutMs: 60_000,
    schema: z
      .object({
        domain: z.string().min(1).max(500).optional(),
        limit: z.union([z.literal(25), z.literal(50), z.literal(100)]).default(50),
        include_subdomains: z.boolean().default(true),
        search: z.string().max(120).optional(),
        sort: z.enum(["rank", "traffic", "volume", "score", "cpc"]).default("traffic"),
        order: z.enum(["asc", "desc"]).default("desc"),
        location_code: z.number().int().positive().optional(),
        language_code: z.string().min(2).max(16).optional(),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_get_domain_pages",
    description:
      "Research the highest-value organic pages for the project domain or another domain. Results are cached for 24 hours and may use the project's research allowance on a cache miss.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "get_domain_pages",
    timeoutMs: 60_000,
    schema: z
      .object({
        domain: z.string().min(1).max(500).optional(),
        limit: z.union([z.literal(25), z.literal(50), z.literal(100)]).default(50),
        include_subdomains: z.boolean().default(true),
        search: z.string().max(120).optional(),
        sort: z.enum(["traffic", "keywords"]).default("traffic"),
        order: z.enum(["asc", "desc"]).default("desc"),
        location_code: z.number().int().positive().optional(),
        language_code: z.string().min(2).max(16).optional(),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_research_keywords",
    description:
      "Discover keyword ideas with demand, difficulty, CPC, competition, intent, monthly trends, and matched Search Console ranking context when available. Results are cached for 24 hours and may use the project's research allowance on a cache miss.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "research_keywords",
    timeoutMs: 60_000,
    schema: z
      .object({
        keyword: z.string().min(1).max(500),
        limit: z.number().int().min(10).max(500).default(50),
        mode: z.enum(["auto", "related", "suggestions", "ideas"]).default("auto"),
        clickstream: z.boolean().default(false),
        location_code: z.number().int().positive().optional(),
        language_code: z.string().min(2).max(16).optional(),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_get_serp_results",
    description:
      "Inspect the current organic results for one keyword to verify search intent, ranking pages, and competing domains. Results are cached for 24 hours and may use the project's research allowance on a cache miss.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "get_serp_results",
    timeoutMs: 60_000,
    schema: z
      .object({
        keyword: z.string().min(1).max(500),
        location_code: z.number().int().positive().optional(),
        language_code: z.string().min(2).max(16).optional(),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_get_backlinks_overview",
    description:
      "Research backlink authority and growth for a domain or exact page. Results are cached for 24 hours and may use the project's research allowance on a cache miss.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "get_backlinks_overview",
    timeoutMs: 60_000,
    schema: z
      .object({
        target: z.string().min(1).max(2_048).optional(),
        scope: z.enum(["domain", "page"]).default("domain"),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_get_ai_citations",
    description:
      "Research historical AI questions, brand mentions, cited sources, and optional competitor share of voice for a brand or domain. Use the Company Project domain by default, not a buyer keyword. Results are cached for 24 hours. A fresh lookup requires explicit user approval before confirmed_cost_usd is supplied.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "get_ai_citations",
    timeoutMs: 120_000,
    schema: z
      .object({
        query: z.string().min(1).max(500).optional(),
        competitors: z.array(z.string().min(1).max(253)).max(10).optional(),
        location_code: z.number().int().positive().optional(),
        language_code: z.string().min(2).max(16).optional(),
        confirmed_cost_usd: z.number().min(0).max(0.24).optional(),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_explore_ai_prompt",
    description:
      "Run an explicitly approved prompt through selected AI answer models and return the answer, citations, fan-out queries, and brand-match evidence.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "explore_ai_prompt",
    timeoutMs: 120_000,
    schema: z
      .object({
        prompt: z.string().min(1).max(10_000),
        models: z
          .array(z.enum(["chat_gpt", "claude", "gemini", "perplexity"]))
          .min(1)
          .max(4)
          .default(["chat_gpt"]),
        highlight_brand: z.string().min(1).max(200).optional(),
        web_search: z.boolean().default(true),
        country_code: z.string().length(2).default("US"),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_list_tracked_ai_queries",
    description:
      "List the Company Project's tracked AI buyer questions, latest checks, plan limit, and next scheduled checks.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "list_tracked_ai_queries",
    schema: z.object({ include_archived: z.boolean().default(false) }).strict(),
  },
  {
    name: "brandwell_visibility_suggest_ai_queries",
    description:
      "Suggest project-bound AI buyer questions from stored Search Console, keyword, business, and citation evidence without tracking them yet.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "suggest_ai_queries",
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
  },
  {
    name: "brandwell_visibility_track_ai_queries",
    description:
      "Add approved buyer questions to the Company Project's tracked AI query portfolio. BrandWell enforces the project plan limit.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "track_ai_queries",
    schema: z
      .object({
        prompts: z.array(z.string().min(1).max(10_000)).min(1).max(50),
        models: z
          .array(z.enum(["chat_gpt", "claude", "gemini", "perplexity"]))
          .min(1)
          .max(4)
          .default(["chat_gpt"]),
      })
      .strict(),
  },
  {
    name: "brandwell_visibility_update_tracked_ai_query",
    description:
      "Pause, resume, archive, or change the model set for one tracked AI buyer question.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "update_tracked_ai_query",
    schema: z
      .object({
        prompt_id: z.number().int().positive(),
        status: z.enum(["active", "paused", "archived"]).optional(),
        models: z
          .array(z.enum(["chat_gpt", "claude", "gemini", "perplexity"]))
          .min(1)
          .max(4)
          .optional(),
      })
      .strict()
      .refine((input) => input.status !== undefined || input.models !== undefined, {
        message: "A status or model change is required",
      }),
  },
  {
    name: "brandwell_visibility_check_tracked_ai_query",
    description:
      "Run an approved tracked AI buyer question now and store its model answers, brand mentions, citations, and fan-out queries.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "check_tracked_ai_query",
    timeoutMs: 120_000,
    schema: z.object({ prompt_id: z.number().int().positive() }).strict(),
  },
  {
    name: "brandwell_rankwell_get_strategy",
    description:
      "Check one keyword or buyer question against stored Search Console rankings, keyword research, tracked AI citation gaps, and existing RankWell content before recommending a new article.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_rankwell_strategy",
    schema: z.object({ keyword: z.string().min(1).max(500) }).strict(),
  },
  {
    name: "brandwell_rankwell_list_briefs",
    description: "List saved RankWell content briefs for this Company Project.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "list_rankwell_briefs",
    schema: z
      .object({
        status: z.enum(["draft", "approved", "converted", "dismissed"]).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
  },
  {
    name: "brandwell_rankwell_create_brief",
    description:
      "Create an editable RankWell content brief from an approved keyword or buyer question. This does not publish content.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "create_rankwell_brief",
    timeoutMs: 120_000,
    schema: z
      .object({
        keyword: z.string().min(1).max(500),
        title: z.string().min(1).max(300).optional(),
        audience: z.string().min(1).max(500).optional(),
        search_intent: z.string().min(1).max(80).optional(),
        recommended_action: z
          .enum(["new_article", "optimize_existing", "merge_pages", "no_action"])
          .optional(),
      })
      .strict(),
  },
  {
    name: "brandwell_rankwell_list_articles",
    description: "List RankWell articles and drafts in this Company Project's Content Hub.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "list_rankwell_articles",
    schema: z
      .object({
        status: z.string().min(1).max(20).optional(),
        search: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(250).default(100),
      })
      .strict(),
  },
  {
    name: "brandwell_rankwell_get_article",
    description:
      "Read one RankWell article with its scores, keyword evidence, sources, media, brief, and revision history.",
    readOnly: true,
    endpoint: "/internal/aimee/visibility/read",
    remoteTool: "get_rankwell_article",
    schema: z.object({ article_id: z.string().min(1).max(80) }).strict(),
  },
  {
    name: "brandwell_rankwell_generate_article",
    description:
      "Generate an editable RankWell article draft from an approved brief or keyword. This does not publish content.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "generate_rankwell_article",
    timeoutMs: 120_000,
    schema: z
      .object({
        brief_id: z.string().min(1).max(80).optional(),
        keyword: z.string().min(1).max(500).optional(),
        title: z.string().min(1).max(300).optional(),
        audience: z.string().min(1).max(500).optional(),
        search_intent: z.string().min(1).max(80).optional(),
        source_material: z.string().min(1).max(100_000).optional(),
      })
      .strict()
      .refine((input) => Boolean(input.brief_id || input.keyword), {
        message: "A brief ID or keyword is required",
      }),
  },
  {
    name: "brandwell_rankwell_refine_article",
    description:
      "Create a new revision of an existing RankWell draft from a focused editorial instruction. This does not publish content.",
    readOnly: false,
    endpoint: "/internal/aimee/visibility/research",
    remoteTool: "refine_rankwell_article",
    timeoutMs: 120_000,
    schema: z
      .object({
        article_id: z.string().min(1).max(80),
        instruction: z.string().min(1).max(2_000),
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
      const idempotencyKey = definition.readOnly
        ? ""
        : `${context.workspaceId}:${call.executionId}`;
      const requestHash = createHash("sha256").update(serialized).digest("hex");
      const signature = createHmac("sha256", this.serviceToken)
        .update(
          [
            `brandwell-aimee-signature:${SIGNATURE_VERSION}`,
            "POST",
            endpoint,
            scope.brandwellCustomerId,
            context.workspaceId,
            context.serviceIdentityId!,
            call.executionId,
            idempotencyKey,
            timestamp,
            requestHash,
          ].join("\n"),
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
          "x-brandwell-signature-version": SIGNATURE_VERSION,
          "x-brandwell-signature": signature,
          ...(idempotencyKey ? { "x-brandwell-idempotency-key": idempotencyKey } : {}),
        },
        body: serialized,
        signal: combineSignals(
          context.signal,
          AbortSignal.timeout(
            "timeoutMs" in definition ? definition.timeoutMs : REQUEST_TIMEOUT_MS,
          ),
        ),
      });
      if (!response.ok) {
        const safeMessage = await safeBrandwellResponseError(response);
        yield {
          type: "error",
          message: safeMessage ?? `BrandWell request failed with status ${response.status}`,
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

async function safeBrandwellResponseError(response: Response): Promise<string | null> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json"))
    return null;
  let payload: unknown;
  try {
    const text = await response.text();
    if (!text || Buffer.byteLength(text, "utf8") > 4_096) return null;
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const code =
    payload && typeof payload === "object" && !Array.isArray(payload) && "code" in payload
      ? String(payload.code ?? "")
      : "";
  const messages: Record<string, string> = {
    SEO_RESEARCH_CONFIRMATION_REQUIRED:
      "A fresh BrandWell visibility lookup requires explicit user approval before it can run.",
    SEO_RESEARCH_LIMIT_REACHED:
      "BrandWell visibility research has reached this Company's configured usage limit.",
    SEO_RESEARCH_PAUSED: "BrandWell visibility research is paused for this Company Project.",
    SEO_RESEARCH_UNAVAILABLE: "BrandWell visibility research is temporarily unavailable.",
  };
  return messages[code] ?? null;
}

function requestFor(
  definition: ToolDefinition,
  parsed: Record<string, unknown>,
): { endpoint: string; body: Record<string, unknown> } {
  if ("remoteTool" in definition) {
    return {
      endpoint: definition.endpoint,
      body: { tool: definition.remoteTool, arguments: parsed },
    };
  }
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
