# BrandWell AIMEE deployment runbook

This runbook covers the managed BrandWell control plane. The generic AIMEE self-hosting guide
remains the source for the underlying Compose topology, backups, computer providers, and upgrades.

## Product topology

Use one BrandWell-hosted control plane with workspace-isolated clients:

```text
portal.brandwell.ai
        |
        | service-to-service management and native tool calls
        v
ai.brandwell.ai
  web + API + worker + Postgres + scheduler
        |
        +-- Client workspace A -> primary AIMEE Team Computer
        |                     +-> Sidekick user 1 private computer
        |                     +-> Sidekick user 2 private computer
        +-- Client workspace B -> isolated Team Computer
        +-- Client workspace C -> isolated Team Computer
```

Never share a computer, service identity, OpenRouter credential, browser profile, connector, or
persistent volume between unrelated customer workspaces. Sidekicks share their client workspace's
service identity and model policy, but each Sidekick has private user access, a private bot, a
private browser profile, and a dedicated computer record.

## Environments

| Environment | Web and API host | GitHub environment | Purpose |
| --- | --- | --- | --- |
| Staging | `https://staging-ai.brandwell.ai` | `brandwell-staging` | Provider-backed acceptance and release candidate testing |
| Production | `https://ai.brandwell.ai` | `brandwell-production` | Client web, mobile API, routines, and managed computers |

Staging and production must use separate databases, persistent volumes, provider credentials,
OpenRouter management credentials, OAuth applications, signing keys, and BrandWell service tokens.

## Required configuration

Start from `.env.example`. Store values in the deployment secret manager, never in Git.

### Core service

- `DATABASE_URL` and `REALTIME_DATABASE_URL`
- `BETTER_AUTH_SECRET`, at least 32 random characters
- `ENCRYPTION_KEY`, independent from every other secret
- `BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL`, all set to the public HTTPS host
- `DATA_DIR` on an encrypted persistent volume with tested off-host backups
- `SIGNUPS_ENABLED=false` for managed launch unless an allowlisted onboarding path is required

### Computer runtime

- `SANDBOX_PROVIDER=e2b`, `daytona`, or `box`
- The matching provider key
- `SANDBOX_IDLE_MS` for suspend-on-idle behavior
- A vision-capable `BRANDWELL_COMPUTER_MODEL`

Do not use the local Docker provider for unrelated production customers.

### BrandWell management and inference

- `BRANDWELL_MANAGEMENT_API_TOKEN`, a dedicated service token with at least 32 characters
- `BRANDWELL_SYSTEM_USER_ID`, an existing system user that owns managed resources
- `OPENROUTER_MANAGEMENT_KEY`, used to create, limit, inspect, disable, and revoke per-client keys
- `OPENROUTER_API_KEY`, the deployment fallback used outside managed client resolution
- `BRANDWELL_OPENROUTER_MONTHLY_LIMIT_USD`
- `BRANDWELL_OPENROUTER_WARNING_LIMIT_USD`
- Optional `BRANDWELL_OPENROUTER_DAILY_LIMIT_USD`
- Optional workload model overrides and fallback models

The management key is required for provisioning, provider-enforced limit changes, usage
reconciliation, and cancellation key revocation. Raw OpenRouter keys must never be returned to web
or mobile clients. The worker reconciles provider usage before evaluating fleet budget alerts.

### Existing BrandWell platform connection

- `BRANDWELL_PLATFORM_API_URL=https://portal.brandwell.ai`
- `BRANDWELL_PLATFORM_SERVICE_TOKEN`, at least 32 characters

The AIMEE control plane and the existing BrandWell portal must hold the same dedicated service
token. Client sessions never receive it. Native Intent, TrafficID, and postcard tools use the
service identity and an explicit BrandWell account ID on every request.

Every native tool request uses the `v1` service signature. Set
`x-brandwell-signature-version: v1` and compute the HMAC-SHA256 over these newline-delimited
values in order: `brandwell-aimee-signature:v1`, method, pathname, BrandWell customer ID, AIMEE
workspace ID, service identity ID, execution ID, idempotency key (blank for reads), ISO timestamp,
and the lowercase SHA-256 hash of the exact request bytes. The portal rejects a changed route,
identity, execution, idempotency key, timestamp, body, or signature version.

The BrandWell portal is the commercial source of truth. It sends a monotonic desired-state
revision containing the agency, client, contract, plan, account status, primary seat, Sidekick seat
count, and skill bundle version. A newly provisioned workspace remains in
`pending_entitlement` and cannot run until that revision is accepted. Stripe contract changes are
stored as durable desired-state events and retried by the BrandWell billing sweep.

Skills are versioned application records installed into each managed user's AIMEE workspace and
injected by the runtime. They are not installed into Daytona. Daytona is the isolated execution
computer for browser, shell, and file work. This separation lets Super Admin roll out a skill
bundle without rebuilding or mutating every sandbox image.

### Retention and health

- `BRANDWELL_HEALTH_INTERVAL_MS=60000`
- `BRANDWELL_RETENTION_DAYS=30`
- `BRANDWELL_DELETE_AFTER_RETENTION=true`

Cancellation immediately disables inference, pauses routines, blocks new work, and suspends the
computer. Connector revocation and destructive cleanup occur only after the retention deadline.

`GET /health` is a lightweight process liveness probe. It does not establish production readiness.
`GET /ready` returns HTTP 200 only when a lowercase 40-character deployment revision is present,
the database and required migration are reachable, a fresh worker heartbeat for that revision
exists, the managed Super Admin and system user are
configured, OpenRouter management and runtime inference are configured, Daytona is selected with
its key and snapshot, and the BrandWell platform bridge is configured. The response contains only
status codes and never returns credential values. Missing or stale requirements return HTTP 503.

## Host preparation

1. Provision a dedicated Linux host or managed container target.
2. Attach encrypted database and application-data storage.
3. Install Docker Engine, the Compose plugin, Git, and a least-privilege deployment user.
4. Clone this repository to a fixed deployment directory.
5. Configure DNS and HTTPS for the environment host.
6. Install host-owned wrappers named `deploy-brandwell-staging` and `deploy-brandwell-main`.
7. Give each wrapper one argument: an immutable 40-character commit SHA.

The wrappers can invoke the checked-in deployment script:

```sh
# deploy-brandwell-staging <sha>
/srv/brandwell-aimee/infra/deploy/deploy-brandwell-revision.sh staging "$1"

# deploy-brandwell-main <sha>
/srv/brandwell-aimee/infra/deploy/deploy-brandwell-revision.sh production "$1"
```

Install the wrappers outside the checkout with root ownership and no write permission for the
deployment account. Set `BRANDWELL_ENV_FILE`, `BRANDWELL_BACKUP_ROOT`, or
`BRANDWELL_READINESS_URL` in the wrapper only when the host differs from the documented layout.

The host-owned command must:

1. acquire an exclusive deployment lock;
2. validate the requested SHA;
3. create and verify a database and `DATA_DIR` backup;
4. fetch and check out only that SHA in the deployment checkout;
5. set `GIT_SHA` to that SHA;
6. run `prisma migrate deploy` through the API startup command;
7. pull the configured immutable image or build the checked-out source;
8. start API, worker, web, and Caddy with `docker-compose.prod.yml`;
9. wait for `/ready` and confirm its reported revision and required checks;
10. restore the previous image or source revision automatically if readiness fails.

Do not place deployment credentials in the repository checkout or expose the Docker socket to the
web, API, or worker containers.

## GitHub deployment configuration

Create these encrypted environment secrets:

```text
BRANDWELL_STAGING_SSH_PRIVATE_KEY
BRANDWELL_STAGING_SSH_KNOWN_HOSTS
BRANDWELL_STAGING_SSH_HOST
BRANDWELL_STAGING_SSH_USER

BRANDWELL_PRODUCTION_SSH_PRIVATE_KEY
BRANDWELL_PRODUCTION_SSH_KNOWN_HOSTS
BRANDWELL_PRODUCTION_SSH_HOST
BRANDWELL_PRODUCTION_SSH_USER
```

Require approval for the `brandwell-production` environment. Set the repository variable
`BRANDWELL_PRODUCTION_DEPLOY_ENABLED=true` only after staging acceptance passes. Staging is a
manual workflow so provider costs cannot start from an ordinary push.

GitHub Actions is enabled on the BrandWell source repository, and the `brandwell-staging` and
`brandwell-production` environments exist. The deployment workflow is on the default branch, but
each environment still needs its deployment secrets. Production keeps a required reviewer and
remains disabled through `BRANDWELL_PRODUCTION_DEPLOY_ENABLED=false` until staging acceptance is
complete. The separate `brandwell-desktop-release` environment must be created and protected before
the first stable desktop tag is pushed.

Public Playwright report publication is optional and disabled by default. To enable it, configure
the `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` repository secrets, configure the `S3_REGION`,
`S3_BUCKET`, `S3_ENDPOINT`, and `PLAYWRIGHT_PUBLIC_BASE_URL` repository variables, and then set
`PLAYWRIGHT_REPORT_PUBLICATION_ENABLED=true`. Leave that flag unset or false when no report bucket
is configured. The trusted publication workflow then skips cleanly instead of failing the CI run.

## Staging release

1. Run all local checks.
2. Push the candidate commit.
3. In Actions, run `deploy-brandwell-staging` and provide the exact commit SHA.
4. Confirm `/ready` returns HTTP 200 and reports the expected revision.
5. Run the acceptance smoke tests below.
6. Record evidence and approve production only after every critical check passes.

Suggested local gate:

```sh
pnpm install --frozen-lockfile
pnpm --filter @rakazo/db exec prisma generate
pnpm lint
pnpm check
pnpm test
pnpm test:integration
pnpm test:e2e
```

Provider-backed tests are explicit because they can create billable resources:

```sh
VERIFY_PROVIDERS=1 pnpm test:canary
pnpm test:daytona
COMPUTER_E2E_MODEL=<vision-capable-model> pnpm test:computer
pnpm test:e2e -- --sandbox=e2b
```

`test:daytona` requires `DAYTONA_API_KEY` and `DAYTONA_SNAPSHOT`. It creates one real AIMEE
computer, verifies primary and secondary desktop streams, checks stop and resume persistence, and
destroys the computer even when an assertion fails. Production deployment runs this acceptance
check after readiness and rolls the revision back if Daytona is not operational.

## Acceptance smoke tests

Use a synthetic BrandWell test customer. Never test cross-tenant boundaries with real customer
records.

### Provisioning

1. Call `POST /internal/workspaces/provision` through the BrandWell Super Admin proxy.
2. Confirm the workspace is blocked in `pending_entitlement` before commercial synchronization.
3. Deliver the BrandWell desired-state revision and verify the stable customer, workspace, service
   identity, and entitlement binding.
4. Verify the workspace-owned employee, service identity, private Team Computer, default routines,
   BrandWell native connections, and isolated OpenRouter credential.
5. Retry with the same idempotency key and confirm no duplicate resources appear.

### Sidekick journey

1. License one Sidekick seat in BrandWell Super Admin.
2. Provision a teammate email and confirm one invitation or existing member assignment.
3. Verify the Sidekick bot is user-owned and private, and has its own browser profile and dedicated
   computer record.
4. Accept the invitation and verify ownership of the bot, thread, memory, routines, browser profile,
   and computer moves to the teammate.
5. Confirm the Sidekick receives the current managed skill bundle and uses the client workspace's
   service identity and OpenRouter child key.
6. Pause and cancel the Sidekick. Confirm routines stop and the provider computer is stopped.
7. Attempt to allocate beyond the licensed seat count and confirm the request fails.

### Client journey

1. Accept the invite and sign in on web and mobile.
2. Connect one OAuth test application.
3. Chat without waking the computer.
4. Request a browser task and verify wake-on-demand.
5. Preview the live computer, take control, complete a test login, release control, and let AIMEE
   resume.
6. Confirm the browser profile persists after suspend and resume.

### Scheduled work and alerts

1. Run a routine while the client is offline.
2. Force a login-required condition and confirm the durable notification plus mobile deep link.
3. Force a repeated failure and confirm one deduplicated alert.
4. Retry from Super Admin and confirm the run and audit trail.

### BrandWell native tools

1. Read only the test account's Intent and TrafficID data.
2. Create a draft postcard campaign.
3. Add synthetic recipients through manual, upload, programmatic, enrichment, and AIMEE paths.
4. Verify one durable queue, Daily default cadence, configured suppression and duplicate rules,
   per-run cap, and next-batch behavior.
5. Confirm AIMEE cannot activate billing, printing, or mailing without a separate approval path.

### Cancellation

1. Cancel the synthetic workspace.
2. Confirm inference is disabled immediately, routines stop, and new runs are blocked.
3. Confirm the computer is suspended and data remains during retention.
4. In a zero-day disposable staging policy, confirm secrets, connectors, provider computer, and
   workspace data are removed by the reconciliation worker.

## Production promotion

Merge only an accepted revision to `main`. The production deploy job runs after the full CI graph
when `BRANDWELL_PRODUCTION_DEPLOY_ENABLED=true`. Verify health, one read-only management request,
worker reconciliation, push delivery, and a non-computer chat before allowing scheduled routines.

## Rollback

Database migrations must be backward compatible with the immediately previous application image.
If a deployment fails:

1. block new provisioning and scheduled routines;
2. keep the failed revision and logs for investigation;
3. restore the prior application image or source SHA;
4. run Compose without applying a destructive reverse migration;
5. verify `/ready`, authentication, worker leases, and management reads;
6. restore the pre-deploy database only if the migration itself corrupted data and after preserving
   the failed database for analysis;
7. reopen routines only after tenant isolation and spend protection checks pass.

Never use `git reset --hard` against a shared working checkout as a deployment rollback mechanism.

## Security release checklist

- Workspace and RBAC isolation tests pass.
- Unauthorized BrandWell operators cannot access unassigned workspaces.
- Management routes reject absent or incorrect service tokens.
- Raw OpenRouter and OAuth credentials never reach browser, mobile, logs, or model context.
- Every support takeover has actor, reason, start, duration, and release audit data.
- Signed computer capabilities expire and cannot cross workspaces.
- One human control lease wins; competing takeover is rejected.
- Persistent data and backups are encrypted and restore-tested.
- Rate limits and spend limits are configured.
- Cancellation revokes inference and eventually removes secrets and provider state.
- No production secrets, customer data, or private URLs are committed.

## Current external launch blockers

Code readiness is not the same as a live environment. The 2026-08-31 release audit confirmed that
the AIMEE control-plane, desktop, provider lifecycle, release-governance, and production-readiness
changes are on `main` at revision `430959e31eb48af625f003fbffa7f57b5c439a80`. The pull request
gate passed lint, typecheck, unit tests, PostgreSQL journeys, production builds, Electron smoke,
Web E2E, and both container image validations.

Daytona account capacity is available: a full-access AIMEE API key exists, the active
`brandwell-aimee-browser-v2` snapshot exists, a staging sandbox exists in a stopped state, and the
account has Tier 3 capacity. Daytona secrets are empty, which is acceptable because deployment
credentials belong in the AIMEE host's secret manager, not inside sandbox images.

Excluding mobile packaging and store submission, provider-backed staging acceptance still requires
all of the following external state:

- rename the public source repository from its legacy name to `ChainAI-Org/brandwell-aimee`;
  official image publication, desktop release publication, and update verification deliberately
  refuse to run under any other repository identity;
- protect `main` and stable `v*` tags, enable secret scanning and push protection, and create the
  protected `brandwell-desktop-release` environment;
- add deployment secrets to the existing `brandwell-staging` and `brandwell-production`
  environments; production currently has a required reviewer and
  `BRANDWELL_PRODUCTION_DEPLOY_ENABLED=false`;
- point `ai.brandwell.ai` and `staging-ai.brandwell.ai` at their AIMEE hosts and issue valid TLS
  certificates; both names currently resolve to the portal DigitalOcean app and fail the TLS
  handshake;
- deploy the accepted revision instead of the older live AIMEE revision
  `6946309d64c762b1e08c34b07efafd682cce1965`, then require `/ready` to report the exact deployed
  revision before promotion;
- place the existing Daytona credential and snapshot name in the staging secret manager, then prove
  provision, execute, suspend, resume, and destroy against a disposable workspace;
- create an OpenRouter management key and store it directly in the staging secret manager; a normal
  inference key cannot create or reconcile tenant child keys;
- configure separate staging database, auth, encryption, signing, and fallback-provider secrets;
- configure the same dedicated BrandWell platform service token on both control planes;
- save the synthetic client entitlement and a centralized default model in BrandWell Super Admin;
  the bridge correctly fails closed until the entitlement exists;
- bind the intended Stripe subscription, reconcile AIMEE and Sidekick quantities, archive duplicate
  prices, and remove duplicate default routines only after their exact live targets are confirmed;
- schedule the BrandWell billing sweep for durable commercial-state retries;
- complete one provider-backed primary AIMEE and Sidekick journey, including isolated credentials,
  managed skill rollout, centralized model replacement, spend reconciliation, pause, cancellation,
  retention, and deletion;
- configure macOS signing and notarization credentials plus Windows Authenticode credentials before
  creating the first stable desktop tag.

Mobile signing, store ownership, physical-device push, deep-link, preview, and takeover evidence
remain a separate release track.

Do not describe AIMEE as production-ready until those checks have passed against the deployed
candidate.
