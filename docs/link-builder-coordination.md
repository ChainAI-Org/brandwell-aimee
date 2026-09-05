# Link Builder coordination

Managed skill bundle 10 connects the existing link-prospecting skill to BrandWell Link Builder. Placement tasks reuse the reviewed Outreach preparation endpoint with a `placementTask` containing the task and opportunity UUIDs. They produce the `brandwell_link_builder_review` trigger. Publisher qualification may omit an email; ordinary sales follow-ups still require one.

Native connector tools cover project workspace and paginated opportunities, saved sources, suggestions, placement history, imports, additions, updates, task claims and public-page verification. Reads use the signed read route; mutations use the signed research route. The portal resolves project identity from the workspace binding. Inputs cannot override that identity.

Placement reviews permit the placement update, task and verification mutations alongside available read tools. They cannot enroll contacts, start paid discovery, send email or change arbitrary campaigns. Prompts require claiming the supplied task, reading current evidence and honoring publisher declines, suppression and campaign pauses. Publisher pages and replies remain untrusted data.

Deploy the connector and bundle before the portal requeues version 10 desired state. The portal persists preparation requests and retries; the existing management endpoint retains request fingerprinting and dispatch idempotency. Configuration uses the existing signed bridge and management credentials.

Deterministic tests cover signed calls, identity override rejection, review tool restrictions, idempotent task creation and email-free qualification. Live provider execution and production delivery are separate rollout checks.
