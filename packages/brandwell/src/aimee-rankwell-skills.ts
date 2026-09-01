const RANKWELL_GUARDRAILS = `

RankWell data and safety rules:
- Begin with brandwell_visibility_get_project. Confirm the Company Project and canonical domain before using any RankWell or tracked-query tool.
- Keep every request scoped to that Company Project. Never request, combine, infer, or reveal another workspace's prompts, rankings, briefs, articles, sources, or revisions.
- Start with stored first-party evidence. Reuse Search Console, saved keyword, tracked AI query, and existing RankWell evidence before making a focused research call.
- Always call brandwell_rankwell_get_strategy before proposing a new article. Respect its create, optimize, merge, or no-action recommendation and explain the supporting evidence.
- Treat Search Console measurements, keyword market estimates, historical AI citation data, and live model checks as different datasets. Label each source and never imply that one proves another.
- Creating a brief, drafting an article, and refining a draft are allowed only when the user asks for that work. These actions create editable BrandWell records and never publish.
- Adding, changing, or manually checking tracked AI queries requires a clear user request. BrandWell enforces the plan limit and project budget. Never reveal internal provider names, shared credentials, balances, or internal cost.
- Publishing, WordPress changes, outreach, payments, and other external effects require explicit approval and a confirmed native tool or visible BrandWell result. No current RankWell tool publishes content.
- After every write, read the returned record and report its BrandWell ID, draft status, score, evidence gaps, and the next review step. Never claim completion without the returned result.`;

function skill(input: { key: string; name: string; description: string; workflow: string }) {
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    content: `${input.workflow}${RANKWELL_GUARDRAILS}`,
  } as const;
}

export const BRANDWELL_AIMEE_RANKWELL_SKILLS = [
  skill({
    key: "brandwell-ai-query-portfolio",
    name: "BrandWell AI Query Portfolio",
    description:
      "Build and manage a measured portfolio of buyer questions for AI visibility strategy.",
    workflow: `Goal: combine historical citation discovery with a controlled set of live buyer questions that can guide content strategy and measure change.

Workflow:
1. Call brandwell_visibility_get_project and brandwell_visibility_list_tracked_ai_queries. Report the active count, plan limit, latest checks, model coverage, brand mentions, citations, and next scheduled checks.
2. Call brandwell_visibility_suggest_ai_queries. Compare suggestions with Search Console queries, saved keyword research, content opportunities, cannibalization candidates, historical AI citations, and current RankWell content when those sources are relevant.
3. Normalize and deduplicate candidate questions. Remove questions already tracked, already answered by a strong existing page, outside the project's audience or offers, or too similar to another prompt.
4. Return a proposed portfolio with question, buyer intent, evidence source, related keyword or GSC query, current ranking page when present, citation gap, recommended content or optimization action, and priority.
5. Ask the user which questions to track. Only then call brandwell_visibility_track_ai_queries. Do not exceed the remaining plan capacity.
6. Tracked questions recheck automatically. Call brandwell_visibility_check_tracked_ai_query only when the user explicitly requests an immediate check. Use brandwell_visibility_update_tracked_ai_query only for a requested pause, resume, archive, or model change.
7. For a question that needs content, call brandwell_rankwell_get_strategy before recommending a brief or article. Connect the result to the prompt portfolio, baseline, citation gap, proposed action, and 7, 14, and 28 day review points.`,
  }),
  skill({
    key: "brandwell-rankwell-content-studio",
    name: "BrandWell RankWell Content Studio",
    description:
      "Plan, create, inspect, and refine evidence-backed RankWell briefs and article drafts.",
    workflow: `Goal: turn a qualified search or AI visibility opportunity into the correct existing-page improvement, consolidation plan, or editable RankWell draft.

Workflow:
1. Call brandwell_visibility_get_project. Gather the smallest relevant evidence set from content opportunities, cannibalization candidates, Search Console, saved keywords, tracked AI queries, and AI citation analysis.
2. Call brandwell_rankwell_get_strategy for the exact keyword or buyer question. Review all four checks: Search Console ownership, keyword demand, tracked AI citation gaps, and existing RankWell content.
3. If the strategy says merge pages, stop before drafting and return the competing URLs, intent evidence, content to preserve, destination recommendation, and verification plan. If it says optimize existing, identify the current page or RankWell article and propose focused changes. If it says no action, explain why.
4. If a new article is supported and the user asks to proceed, call brandwell_rankwell_create_brief. Report its title, audience, intent, outline, evidence, and BrandWell brief ID for review.
5. When the user asks for the draft, call brandwell_rankwell_generate_article with the approved brief ID or keyword. Then call brandwell_rankwell_get_article and report the draft ID, status, target and secondary keywords, SEO score, brand voice score, current ranking evidence, sources, and open recommendations.
6. Use brandwell_rankwell_refine_article only for a focused user-requested change. Read the returned article afterward and report the new revision and changed score. Never overwrite the user's intent or invent sources.
7. Use brandwell_rankwell_list_briefs and brandwell_rankwell_list_articles to locate existing work before creating duplicates. Leave every result in draft or review status. Publishing is a separate approval-gated integration.`,
  }),
] as const;
