# Outreach notifications and reviewed follow-ups

BrandWell Outreach can target account AIMEE users or the CRM deal owner. The management API resolves BrandWell user identifiers to current workspace members. The notification list, read/resolve actions, and push delivery enforce that audience. An empty audience retains the existing workspace-wide notification behavior.

Outreach notifications open the account's Sources and workflows screen in the BrandWell portal, including on mobile. The portal checks the signed-in user's account access. When a user selects Ask AIMEE to prepare, `POST /internal/workspaces/:id/outreach-followup` creates a native task for that user's active employee. It requires management authentication, operator attribution, active commercial entitlement, and a stable idempotency key. Retries reuse the saved task and run.

Preparation verifies the contact identity and drafts a LinkedIn connection note for review. A dedicated run trigger restricts both exposed tools and execution to read-only tools. Computer actions, shell access, sending, writes, and delegated execution are unavailable in this task even when the employee normally has those permissions. If research access is missing, AIMEE reports the missing connection. Sending a connection or message requires a separate user instruction.

Apply the notification-recipient migration before updating the API or worker. The portal and Outreach engine releases provide the enrollment, workflow configuration, and review controls. This release alone does not activate campaigns or submit messages.
