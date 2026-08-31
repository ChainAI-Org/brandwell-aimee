const CACHED_VISIBILITY_GUARDRAILS = `

Data and safety rules:
- Begin with brandwell_visibility_get_project. Confirm the Company Project and canonical domain before using any other visibility tool.
- Use only project-bound BrandWell tools. The approved read tools are brandwell_visibility_get_overview, brandwell_visibility_get_search_console, brandwell_visibility_get_analytics, brandwell_visibility_list_saved_keywords, brandwell_visibility_get_rank_tracking, brandwell_visibility_list_site_audits, and brandwell_visibility_get_site_audit.
- These tools read stored snapshots. They do not refresh providers, start crawls, change project settings, save keywords, or spend credits.
- State the source, reporting window, connection status, and fetched time when the tool returns them. Separate measured evidence from your interpretation.
- If a connection is missing, a snapshot is stale, or the needed data is unavailable, say exactly what is missing. Ask the user to open the matching BrandWell Visibility page to update or connect it. Never invent a result or bypass the cache with a paid provider call.
- Keep every request scoped to the Company Project returned by brandwell_visibility_get_project. Never request, combine, infer, or reveal another workspace's data.
- Web research may supplement project data when the user asks for current public evidence. Cite the public source and date. Do not present public estimates as first-party BrandWell measurements.
- Analysis, plans, briefs, and drafts are allowed. Publishing, outreach, purchases, account changes, and other external effects require explicit approval.`;

function skill(input: { key: string; name: string; description: string; workflow: string }) {
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    content: `${input.workflow}${CACHED_VISIBILITY_GUARDRAILS}`,
  } as const;
}

export const BRANDWELL_AIMEE_VISIBILITY_SKILLS = [
  skill({
    key: "brandwell-visibility-project-setup",
    name: "BrandWell Visibility Project Setup",
    description:
      "Establish the domain, market, goals, positioning, competitors, and measurement status for a Company Project.",
    workflow: `Goal: orient one Company Project so later visibility work starts from the correct business context.

Workflow:
1. Call brandwell_visibility_get_project and summarize the Company Project, canonical domain, country, language, business description, target audience, brand terms, and competitors already stored.
2. Ask only for missing or disputed context in small batches: the primary business goal, success metric, timeframe, offers, best-fit audience, positioning, important pages, competitors, voice constraints, and topics to avoid.
3. Check brandwell_visibility_get_search_console and brandwell_visibility_get_analytics. Report each connection as connected, not connected, or unavailable based only on the returned status.
4. Do not claim to save project settings. Give the user a concise, copy-ready settings summary and direct them to BrandWell Company Project settings for any changes.
5. Finish with a status table for domain, market, goal, positioning, competitors, key pages, Search Console, Analytics, and the single best next workflow.

Choose the next workflow from Site Health Audit, Keyword Research, Keyword Clustering, Competitive Landscape, Competitor Analysis, Local Visibility, Link Prospecting, or AI Citation Analysis.`,
  }),
  skill({
    key: "brandwell-visibility-coach",
    name: "BrandWell Visibility Coach",
    description:
      "Choose the next search or AI visibility workflow and explain the evidence in plain language.",
    workflow: `Goal: help the user choose one practical next visibility action without overwhelming them.

Workflow:
1. Call brandwell_visibility_get_project and ask whether the user wants strategy, execution help, or an explanation.
2. Use the smallest relevant evidence set. Start with brandwell_visibility_get_search_console for organic search questions, brandwell_visibility_get_overview for domain or AI visibility questions, and brandwell_visibility_get_analytics for website outcomes.
3. Explain what the data means in plain language. Use clicks, impressions, CTR, average position, sessions, engagement, rankings, site health, and AI citations only when those measurements are present.
4. Recommend one workflow and one immediate next action. Offer at most three alternatives.
5. End with what is known, what is missing, why the recommendation fits the business goal, and what the user should do next.`,
  }),
  skill({
    key: "brandwell-site-health-audit",
    name: "BrandWell Site Health Audit",
    description:
      "Turn the latest stored site crawl and first-party search evidence into a concise, prioritized audit.",
    workflow: `Goal: produce a plain-language site health report centered on one action the user can take this week.

Workflow:
1. Call brandwell_visibility_get_project, brandwell_visibility_list_site_audits, and brandwell_visibility_get_search_console.
2. Select the newest completed audit for the canonical domain. If none exists, stop and ask the user to run Site Health from BrandWell Visibility.
3. Call brandwell_visibility_get_site_audit with that audit ID. Group page findings by impact: blocking access or indexing, broken responses and redirects, missing or conflicting page signals, thin or duplicate content, and performance evidence.
4. Cross-check priorities against Search Console. Favor issues affecting pages or queries with meaningful impressions, clicks, or business importance.
5. Report the audit date, pages crawled, scope limits, evidence, the one recommended action, three supporting fixes, affected URLs, expected outcome, and a verification checklist.
6. Do not start a crawl, claim a live page was checked, or infer an issue outside the stored audit unless you separately inspect the public page and label that evidence.`,
  }),
  skill({
    key: "brandwell-keyword-research",
    name: "BrandWell Keyword Research",
    description:
      "Prioritize keyword opportunities from Search Console, saved keywords, rankings, and current public search evidence.",
    workflow: `Goal: find keyword opportunities that fit the business, the audience's intent, and pages the site can realistically support.

Workflow:
1. Call brandwell_visibility_get_project, brandwell_visibility_get_search_console with up to 100 rows, brandwell_visibility_list_saved_keywords, and brandwell_visibility_get_rank_tracking.
2. Start with first-party demand. Identify high-impression low-CTR terms, positions 5 through 20, declining queries, queries growing without a strong landing page, and terms already converting when Analytics evidence is available.
3. Merge saved keyword volume, difficulty, CPC, competition, intent, and tags when present. Never substitute a dash or zero for a missing metric.
4. Remove duplicates, off-topic terms, unwanted branded terms, and keywords that require a product or audience the company does not serve.
5. Prioritize business fit and intent first, then achievable position, existing authority, demand, and competition. Volume alone never decides priority.
6. Return a shortlist with keyword, intent, evidence source, current page, clicks, impressions, CTR, average position, saved volume and difficulty when available, recommended page or action, and rationale.
7. Do not claim broad keyword discovery occurred unless the candidate terms were present in stored BrandWell data or current public search evidence supplied during the session.`,
  }),
  skill({
    key: "brandwell-keyword-clustering",
    name: "BrandWell Keyword Clustering",
    description:
      "Group stored keywords and Search Console queries by intent, page type, and landing-page fit.",
    workflow: `Goal: turn a known keyword set into page groups, priorities, and cannibalization checks.

Workflow:
1. Call brandwell_visibility_get_project, brandwell_visibility_list_saved_keywords, and brandwell_visibility_get_search_console with up to 100 rows.
2. Normalize case and whitespace, remove duplicates, and retain each term's measured clicks, impressions, CTR, position, volume, difficulty, intent, and current page when present.
3. Cluster by shared search intent and page type, not by word overlap alone. Separate informational, commercial investigation, comparison, transactional, navigational, and local intent when the evidence supports it.
4. Map every useful cluster to an existing important page, a proposed new page, or a no-target decision.
5. Flag cannibalization only when multiple project URLs receive impressions for the same or substantially equivalent intent. Show the supporting query and URL rows.
6. Return a table with cluster, primary keyword, supporting terms, combined known demand, intent, current URLs, recommended target, action, priority, and evidence gaps.
7. Do not save tags or change pages. Provide copy-ready tags and mapping recommendations for user review.`,
  }),
  skill({
    key: "brandwell-competitive-landscape",
    name: "BrandWell Competitive Landscape",
    description:
      "Map the search and AI visibility landscape around the project's confirmed market and competitors.",
    workflow: `Goal: identify who consistently wins the searches and AI citations that matter, then show where the Company Project has a credible opening.

Workflow:
1. Call brandwell_visibility_get_project and brandwell_visibility_get_overview. Use the stored competitor list as the starting roster and confirm which competitors matter to the user.
2. Anchor the project's own position with brandwell_visibility_get_search_console, brandwell_visibility_get_rank_tracking, and AI visibility evidence from brandwell_visibility_get_overview.
3. When the user requests current competitor evidence, use public web search for a representative query set and record the query, locale, date, ranking or citation source, and observed page type. Do not use paid competitor APIs.
4. Group recurring winners as direct competitors, publishers, directories, marketplaces, communities, or unrelated domains.
5. Compare visible content types, topics, positioning, source authority, local presence, and citation patterns. Label every competitor metric not measured by BrandWell as public observation or unavailable.
6. Return the query set, recurring domains, why each wins, the project's current evidence, underserved angles, and the top three actions.`,
  }),
  skill({
    key: "brandwell-competitor-analysis",
    name: "BrandWell Competitor Analysis",
    description:
      "Analyze one confirmed competitor using public evidence and the project's stored BrandWell baseline.",
    workflow: `Goal: turn one competitor comparison into a practical page, content, distribution, or citation plan.

Workflow:
1. Call brandwell_visibility_get_project and confirm the competitor domain, market, comparison goal, and whether it appears in the stored competitor list.
2. Build the Company's baseline from brandwell_visibility_get_search_console, brandwell_visibility_get_overview, brandwell_visibility_get_rank_tracking, and brandwell_visibility_get_analytics as relevant.
3. Inspect the competitor's public site and current public search results only when the user asks for current research. Capture URLs, titles, page types, claims, visible content depth, structured information, and cited sources. Never claim private traffic, keyword, backlink, or conversion metrics.
4. Group observed competitor strengths by query ownership, content themes, page formats, positioning, authority signals, local signals, and AI citation sources.
5. Separate confirmed evidence, reasonable inference, and unknowns.
6. Return an executive summary, evidence table, overlapping opportunities, gaps the Company can credibly own, pages to improve or create, and a prioritized 30-day plan.`,
  }),
  skill({
    key: "brandwell-local-visibility",
    name: "BrandWell Local Visibility",
    description:
      "Assess local search readiness and prioritize profile, location-page, review, and local authority work.",
    workflow: `Goal: improve visibility for a physical location or service area using verified project and public local evidence.

Workflow:
1. Call brandwell_visibility_get_project and confirm the business name, address or service area, primary categories, target locations, and main local conversion goal.
2. Use brandwell_visibility_get_search_console to identify local queries, locations in page URLs, CTR gaps, and pages already receiving impressions. Use brandwell_visibility_get_analytics only for available website outcomes.
3. If current local-pack or business-profile evidence is required, use public search or browser inspection and record the exact query, location, date, listing, category, rating, review count, hours, website target, and visible profile completeness.
4. Compare the project against two or three relevant local competitors. Do not infer grid rankings, review sentiment, listing ownership, or proximity performance without direct evidence.
5. Prioritize eligibility and accuracy first, then category and landing-page fit, review recency and replies, local authority, profile content, and ongoing posts.
6. Return a local visibility scorecard, evidence gaps, location-page recommendations, review and citation actions, and the one highest-impact next step.`,
  }),
  skill({
    key: "brandwell-link-prospecting",
    name: "BrandWell Link Prospecting",
    description:
      "Find relevant public link and citation prospects for a verified BrandWell asset without sending outreach.",
    workflow: `Goal: build a qualified prospect list and a truthful outreach angle for a page, tool, study, template, dataset, or expert point of view that deserves a reference.

Workflow:
1. Call brandwell_visibility_get_project and confirm the target asset, audience, market, proof, and why a third party would cite it.
2. Use the stored Company Project competitors and Search Console queries to build five to ten public prospecting searches. Useful patterns include topic resources, category tools, alternatives, statistics, guides, examples, templates, associations, directories, and local partners.
3. Inspect candidate pages and qualify topical fit, audience overlap, editorial relevance, freshness, linking pattern, and contact path. Reject scraped lists, link farms, irrelevant directories, paid-link schemes, and sites with no credible connection to the asset.
4. Record the prospect URL, source query, evidence, recommended asset, suggested angle, contact path source, and confidence. Do not guess an email address or person.
5. Return a prioritized prospect table and concise draft messages. Drafts must use only verified claims and must not be sent without explicit approval.`,
  }),
  skill({
    key: "brandwell-ai-citation-analysis",
    name: "BrandWell AI Citation Analysis",
    description:
      "Analyze stored AI mentions and cited pages, then prioritize changes that can improve brand discoverability.",
    workflow: `Goal: explain where the brand appears in AI search, which project pages earn citations, and what evidence-backed work could improve discoverability.

Workflow:
1. Call brandwell_visibility_get_project and brandwell_visibility_get_overview. Use only the stored AI visibility snapshot for measured mention counts, AI search volume, platforms, and cited pages.
2. Report snapshot age, market scope, platform coverage, missing metrics, and whether the canonical domain appears in each cited URL.
3. Rank cited pages by mentions and known AI search volume. Group them by page type, topic, and user intent when the URLs or verified public pages support the grouping.
4. Identify coverage gaps by comparing cited topics with the business goal, Search Console queries, saved keywords, and the project's important offers. Use brandwell_visibility_get_search_console and brandwell_visibility_list_saved_keywords when those comparisons help.
5. When the user asks for current answer-level evidence, use public web research and clearly distinguish it from BrandWell measurements. Never claim a prompt was tested or a model answer was observed unless it was actually run in the current session.
6. Return total mentions, platform mix, top cited pages, citation gaps, source-quality observations, content or technical actions, and a prioritized measurement plan.`,
  }),
] as const;
