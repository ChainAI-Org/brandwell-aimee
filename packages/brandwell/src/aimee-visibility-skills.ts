const VISIBILITY_GUARDRAILS = `

Data and safety rules:
- Begin with brandwell_visibility_get_project. Confirm the Company Project and canonical domain before using any other visibility tool.
- Use only project-bound BrandWell tools. Free stored-data tools include overview, Search Console, Analytics, content opportunities, cannibalization candidates, saved keywords, rank tracking, and stored site audits.
- Research tools include domain overview, domain keywords, domain pages, keyword research, SERP results, backlinks, AI citations, and AI Prompt Explorer. A cache miss may use the Company Project's research allowance. Results are cached by project and input for 24 hours.
- Start with stored first-party evidence. Use the smallest focused research call set needed to answer the question, reuse a fresh cached result, and never fan out redundant provider calls.
- State the source, reporting window, connection status, and fetched time when the tool returns them. Separate measured evidence from your interpretation.
- If a connection is missing, a snapshot is stale, or the needed data is unavailable, say exactly what is missing. Ask the user to connect the source or open the matching BrandWell Visibility page when that is the required next step. Never invent a result.
- If BrandWell blocks research for approval or a project budget rule, explain the requested research in customer language and wait. Never reveal the underlying provider, account balance, internal cost, or shared credentials.
- Run brandwell_visibility_explore_ai_prompt only when the user explicitly asks to test a current AI answer or approves the proposed prompt and model set. Default to one model unless cross-model comparison is material.
- Keep every request scoped to the Company Project returned by brandwell_visibility_get_project. Never request, combine, infer, or reveal another workspace's data.
- Web research may supplement project data when the user asks for current public evidence. Cite the public source and date. Do not present public estimates as first-party BrandWell measurements.
- Analysis, plans, briefs, and drafts are allowed. Publishing, outreach, purchases, account changes, and other external effects require explicit approval.`;

function skill(input: { key: string; name: string; description: string; workflow: string }) {
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    content: `${input.workflow}${VISIBILITY_GUARDRAILS}`,
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

Choose the next workflow from Site Health Audit, Content Opportunities, Content Consolidation, Keyword Research, Keyword Clustering, Competitive Landscape, Competitor Analysis, Local Visibility, Link Prospecting, or AI Citation Analysis.`,
  }),
  skill({
    key: "brandwell-visibility-coach",
    name: "BrandWell Visibility Coach",
    description:
      "Choose the next search or AI visibility workflow and explain the evidence in plain language.",
    workflow: `Goal: help the user choose one practical next visibility action without overwhelming them.

Workflow:
1. Call brandwell_visibility_get_project and ask whether the user wants strategy, execution help, or an explanation.
2. Use the smallest relevant evidence set. Start with brandwell_visibility_get_content_opportunities for existing-page optimization, brandwell_visibility_get_cannibalization_candidates for competing pages, brandwell_visibility_get_search_console for other organic search questions, brandwell_visibility_get_overview for the saved visibility baseline, and brandwell_visibility_get_analytics for website outcomes.
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
5. When authority or market footprint determines the priority, call brandwell_visibility_get_domain_overview and brandwell_visibility_get_backlinks_overview once for the canonical domain. Reuse fresh results.
6. Report the audit date, pages crawled, scope limits, evidence, the one recommended action, three supporting fixes, affected URLs, expected outcome, and a verification checklist.
7. Do not start a crawl, claim a live page was checked, or infer an issue outside the stored audit unless you separately inspect the public page and label that evidence.`,
  }),
  skill({
    key: "brandwell-keyword-research",
    name: "BrandWell Keyword Research",
    description:
      "Prioritize keyword opportunities from Search Console, saved keywords, rankings, and current public search evidence.",
    workflow: `Goal: find keyword opportunities that fit the business, the audience's intent, and pages the site can realistically support.

Workflow:
1. Call brandwell_visibility_get_project, brandwell_visibility_get_content_opportunities, brandwell_visibility_get_search_console with up to 100 rows, brandwell_visibility_list_saved_keywords, and brandwell_visibility_get_rank_tracking.
2. Start with first-party demand. Identify high-impression low-CTR terms, positions 4 through 20, queries growing without a strong landing page, and pages already close to meaningful visibility.
3. If the known set does not answer the request, make one focused brandwell_visibility_research_keywords call from the best-fit seed. Its results may already contain exact-query Search Console position, page, clicks, impressions, CTR, and competing-page context. Use brandwell_visibility_get_serp_results only for the finalists whose intent or page type is unclear.
4. Merge measured volume, difficulty, CPC, competition, intent, trends, and tags when present. Never substitute a dash or zero for a missing metric.
5. Remove duplicates, off-topic terms, unwanted branded terms, and keywords that require a product or audience the company does not serve.
6. Prioritize business fit and intent first, then achievable position, existing authority, demand, and competition. Volume alone never decides priority.
7. Return a shortlist with keyword, intent, evidence source, current page, clicks, impressions, CTR, average position, measured volume and difficulty when available, recommended page or action, and rationale.
8. Label first-party Search Console data separately from third-party market estimates and public observations.`,
  }),
  skill({
    key: "brandwell-keyword-clustering",
    name: "BrandWell Keyword Clustering",
    description:
      "Group stored keywords and Search Console queries by intent, page type, and landing-page fit.",
    workflow: `Goal: turn a known keyword set into page groups, priorities, and cannibalization checks.

Workflow:
1. Call brandwell_visibility_get_project, brandwell_visibility_list_saved_keywords, brandwell_visibility_get_search_console with up to 100 rows, and brandwell_visibility_get_cannibalization_candidates.
2. Normalize case and whitespace, remove duplicates, and retain each term's measured clicks, impressions, CTR, position, volume, difficulty, intent, and current page when present.
3. Cluster by shared search intent and page type, not by word overlap alone. Separate informational, commercial investigation, comparison, transactional, navigational, and local intent when the evidence supports it.
4. Map every useful cluster to an existing important page, a proposed new page, or a no-target decision.
5. Treat the cannibalization tool as an exact-query conflict detector, not an automatic merge decision. For meaningful candidates, inspect both pages and call brandwell_visibility_get_serp_results for the shared query to verify intent and ranking-page overlap.
6. Recommend keep separate, retarget, canonicalize, or merge and redirect only after comparing purpose, content overlap, backlinks, conversions when available, and the SERP. Show the supporting query and URL rows.
7. Return a table with cluster, primary keyword, supporting terms, combined known demand, intent, current URLs, recommended target, action, priority, and evidence gaps.
8. Do not save tags or change pages. Provide copy-ready tags and mapping recommendations for user review.`,
  }),
  skill({
    key: "brandwell-content-opportunities",
    name: "BrandWell Content Opportunities",
    description:
      "Find the lowest-hanging existing pages to optimize from first-party search evidence and verified intent.",
    workflow: `Goal: identify the existing pages most likely to gain qualified organic traffic from a focused optimization pass.

Workflow:
1. Call brandwell_visibility_get_project and brandwell_visibility_get_content_opportunities. If Search Console is not connected or has no usable rows, explain that this workflow needs first-party query and page evidence.
2. Call brandwell_visibility_get_search_console for the leading pages. Use Analytics only when page-level business outcome evidence is actually available. Do not treat sitewide sessions as page conversion evidence.
3. Rank opportunities by business fit, query intent, impressions, current position, CTR gap, and the number of related queries. The tool score is a prioritization signal, not a promise of traffic.
4. Inspect each finalist's current public page. Call brandwell_visibility_get_serp_results for up to three primary queries when the ranking page type or intent is unclear.
5. For each recommended page, specify the target query, current clicks, impressions, CTR, position, why it is winnable, the exact title, content, internal-link, or intent-alignment change, and how to verify the result after the next reporting window.
6. Return the best five pages first, followed by lower-confidence candidates and evidence gaps. Do not recommend a new page when the existing page can satisfy the intent with a focused improvement.`,
  }),
  skill({
    key: "brandwell-content-consolidation",
    name: "BrandWell Content Consolidation",
    description:
      "Identify pages competing for the same queries and decide whether to separate, retarget, canonicalize, or merge them.",
    workflow: `Goal: resolve genuine page competition without merging useful pages that serve different intent.

Workflow:
1. Call brandwell_visibility_get_project and brandwell_visibility_get_cannibalization_candidates. Start with strong candidates that have meaningful impressions across at least two URLs.
2. For each candidate, compare the page purpose, primary intent, content overlap, clicks, impressions, CTR, position, and any known backlinks or business role. Inspect the live pages when accessible.
3. Call brandwell_visibility_get_serp_results for the shared query. If the SERP supports multiple page types or intents, prefer differentiation and retargeting. If the pages answer the same intent and split authority, consider consolidation.
4. Use brandwell_visibility_get_backlinks_overview for exact pages only when link equity could change the destination decision.
5. Classify every pair as keep separate, differentiate, retarget one page, canonicalize, or merge and redirect. Include confidence, evidence, destination URL, content to preserve, internal links to update, redirect requirement, and post-change validation.
6. Never instruct a merge from the exact-query signal alone. Mark cases with unclear intent, conversion value, or canonical evidence for manual review.`,
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
3. Use brandwell_visibility_get_serp_results for a representative query set. Group recurring winners as direct competitors, publishers, directories, marketplaces, communities, or unrelated domains.
4. Call brandwell_visibility_get_domain_overview for the three to five strongest recurring domains, then brandwell_visibility_get_domain_keywords for direct competitors that warrant deeper theme analysis. Use brandwell_visibility_get_backlinks_overview only when authority may explain the gap.
5. Compare measured organic footprint, ranking themes, visible content types, positioning, link authority, and AI citation patterns. Label estimates, first-party evidence, and public observations separately.
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
3. Call brandwell_visibility_get_domain_overview, brandwell_visibility_get_domain_keywords, and brandwell_visibility_get_domain_pages for the competitor. Use brandwell_visibility_get_backlinks_overview when authority matters and brandwell_visibility_get_serp_results for the most important shared terms.
4. Inspect the competitor's public pages before making content-depth, positioning, structured-data, or page-type claims. Provider estimates are not private analytics or conversion data.
5. Group competitor strengths by query ownership, content themes, page formats, positioning, authority signals, local signals, and AI citation sources.
6. Separate confirmed evidence, reasonable inference, and unknowns.
7. Return an executive summary, evidence table, overlapping opportunities, gaps the Company can credibly own, pages to improve or create, and a prioritized 30-day plan.`,
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
2. Use the stored Company Project competitors and Search Console queries to build five to ten prospecting searches. Call brandwell_visibility_get_serp_results for the strongest patterns. Useful patterns include topic resources, category tools, alternatives, statistics, guides, examples, templates, associations, directories, and local partners.
3. Call brandwell_visibility_get_backlinks_overview for the most relevant competitor or target page when its link pattern can reveal prospect types. Use brandwell_visibility_get_domain_overview only to qualify important domains.
4. Inspect candidate pages and qualify topical fit, audience overlap, editorial relevance, freshness, linking pattern, and contact path. Reject scraped lists, link farms, irrelevant directories, paid-link schemes, and sites with no credible connection to the asset.
5. Record the prospect URL, source query, evidence, recommended asset, suggested angle, contact path source, and confidence. Do not guess an email address or person.
6. Return a prioritized prospect table and concise draft messages. Drafts must use only verified claims and must not be sent without explicit approval.`,
  }),
  skill({
    key: "brandwell-ai-citation-analysis",
    name: "BrandWell AI Citation Analysis",
    description:
      "Analyze stored AI mentions and cited pages, then prioritize changes that can improve brand discoverability.",
    workflow: `Goal: explain where the brand appears in AI search, which project pages earn citations, and what evidence-backed work could improve discoverability.

Workflow:
1. Call brandwell_visibility_get_project and brandwell_visibility_get_ai_citations. Historical citation lookup targets a brand or domain, so use the canonical domain and saved competitors unless the user supplies another brand or domain. Never pass a buyer keyword as the historical lookup target. Filter the returned questions for topic relevance instead.
2. Explain that historical citation discovery and live prompt testing are different datasets. Report fetched time, market scope, platform coverage, missing metrics, and the exact questions and sources returned by the citation index.
3. Rank questions and cited pages by mentions and known AI search volume. Group them by page type, topic, buyer intent, and whether the canonical domain is cited.
4. Identify coverage gaps by comparing cited topics with the business goal, Search Console queries, saved keywords, and the project's important offers. Use brandwell_visibility_get_search_console and brandwell_visibility_list_saved_keywords when those comparisons help.
5. When the user explicitly asks to test a current answer, propose the exact prompt and smallest useful model set, then call brandwell_visibility_explore_ai_prompt after approval. Report each model separately, including answer text, citations, fan-out queries, web-search state, and whether the brand was actually mentioned.
6. Never infer that a historical question is continuously tracked or that a citation equals a recommendation. Use the tracked AI query portfolio for keyword-level and buyer-question measurement. If a historical lookup needs a fresh paid request, explain that approval is required and do not supply confirmed_cost_usd until the user explicitly approves the current lookup. Never claim a prompt was tested unless the live tool returned a result in the current session.
7. Return total mentions, platform mix, share of voice when competitors were supplied, top questions, top cited pages, citation gaps, source-quality observations, content or technical actions, and a prioritized measurement plan.`,
  }),
] as const;
