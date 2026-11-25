# Implementation checkpoints

The accepted specification is [PLAN.md](PLAN.md). This file is the handoff between sittings.

| Segment | Status |
| --- | --- |
| Repository foundation | Implemented and verified against an authenticated Scoop replica set |
| Accounts and access | Backend implemented with local replica-set verification |
| Sessions and bookings | Backend implemented with local replica-set verification |
| Queue engine | Backend implemented with local replica-set verification |
| Demonstration UI and live updates | Implemented with local browser and replica-set verification |
| Hardening and operating documentation | Local verification and hosted CI passed, including Docker Compose. Hosted deployment checks pending |
| Patient and staff browser workflow refinement | Implemented with desktop and mobile browser verification |

## Completed in the foundation sitting

- Saved the accepted plan before implementation and initialized a local Git repository on `main`.
- Added `AGENTS.md` to preserve product boundaries and the segmented workflow across chats.
- Created top-level frontend/backend packages and shared public contracts, coordinated with pnpm/Turborepo.
- Pinned the installed Node LTS toolchain and dependencies; generated the workspace lockfile. Used supported ESLint tooling and pnpm's current `allowBuilds` configuration. TypeScript stays on a version supported by typescript-eslint.
- Added strict TypeScript settings, linting, build/test commands and a GitHub Actions workflow.
- Added Express application factory, environment validation, MongoDB replica-set readiness checks, safe error responses, request IDs, redacted logging and graceful shutdown.
- Added Next.js preview with same-origin API forwarding and a service connection button; no fake patient/queue functionality.
- Added local-only MongoDB Compose configuration, idempotent replica-set initialization and database-check command.
- Documented setup, commands, infrastructure boundaries and future work in README.md.

## Verification actually performed

- `pnpm check`: passed lint, typecheck, backend configuration/HTTP tests and production builds for backend, frontend and contracts.
- `pnpm install --frozen-lockfile --offline`: passed, confirming the saved lockfile matches the installed workspace.
- Tests cover database-unavailable readiness, liveness independence, response schemas, generated request IDs, secret-free errors, malformed/oversized bodies and invalid environment handling.
- A temporary production Next.js server returned the expected preview page over localhost; it was stopped after the smoke check.
- The sandbox initially blocked localhost connections used by Supertest. Re-running the verification suite with approved local-network access passed. This was an environment limitation, not a test assertion failure.
- Live MongoDB/Compose verification was NOT run: Docker, mongod and mongosh are not installed locally. The CI workflow includes `db:up` and `db:check`, but CI has not been executed remotely.
- No real patient data, credentials, deployments or remote repository were created.

## Windows MongoDB setup

- Installed MongoDB through Scoop and started a password-protected single-member replica set bound to `127.0.0.1:27017`. The local process starts manually and persists its data in `.mongodb-local/`.
- Added a PowerShell launcher and a bootstrap command. The app receives a generated `readWrite` credential through `MONGODB_URI` in `backend/.env`. The separate user administrator password and replica key live under `.mongodb-local/`. Git ignores both locations.
- Documented the Scoop and Compose workflows and how to supply an Atlas URI when the project moves to Atlas.
- `pnpm check` passed with Turbo caching bypassed on the pinned Node and pnpm versions. `pnpm db:check` passed against the running authenticated replica set. A second bootstrap succeeded using the existing credentials.
- A live smoke test committed and read back a transaction, confirmed that MongoDB rejected an unauthenticated write and an app-user administration request, then dropped the temporary collection. The compiled backend returned `ready` from its readiness endpoint.
- The local Compose workflow and Atlas connection were not exercised in this sitting. MongoDB was left running locally. The system PATH selects a newer Node version, so verification used the already-installed pinned Node for the command session.

## Course proposal draft

- Added [copy-ready proposal slide text](COURSE-PITCH.md) using the supplied proposal as a structural reference and the accepted plan as the content source.
- Reviewed the draft against the plan and checkpoint status. It presents the verified foundation as current work and the booking and queue demo as planned work. Course and team details are placeholders.
- Documentation only. No application or database checks were run in this sitting.

## Accounts and access

- Added public identity contracts, separately validated MongoDB documents, and an explicit migration for validators, unique and partial indexes, and TTL cleanup. API startup checks for the migration.
- Added password authentication with Argon2id, hashed opaque sessions, strict same-origin writes, throttled expiring challenges, and account-specific optional phone login. Shared contact numbers remain nonunique and do not authorize access.
- Added patient OTP signup, staff preregistration and corrections, exact-login minimal lookup, reissuable single-use setup tokens, and authenticated self-service profile edits.
- Added idempotent superuser seeding, practice provisioning and paid-access status controls, and doctor-owned assistant invitation, activation, and revocation. Assignment, credential, and practice writes serialize permission-sensitive changes. Audits record scope and actor without secrets.
- Added recovery using the authorized phone and a separately purposed operator token for accounts without a grant. The operator flow requires superuser reauthentication and an opaque reference to an identity-verification case handled outside the application.
- Added a CI integration step that uses a real replica set. The integration command creates uniquely prefixed fixture collections with synthetic records and removes them on completion.

### Verification actually performed

- `pnpm check` passed lint, type checks, unit tests, and production builds with Turbo caching bypassed on the pinned toolchain.
- `pnpm db:check` and `pnpm --filter @practice/backend test:integration` passed on the authenticated Scoop replica set. The suite exercises database constraints, shared-phone isolation, OTP limits and expiry, setup expiry and replay, both recovery paths, tenant permissions, concurrent invitations, and assistant activation racing with revocation.
- `pnpm --filter @practice/backend db:migrate` succeeded on the local development database and on a repeat run. The compiled backend reported ready, required authentication for the self endpoint, and rejected login without the configured origin. The production startup gate also returned the expected failure.
- The new CI step is configured. Remote CI and Docker Compose verification remain pending.

### Limits at this checkpoint

- Development uses an in-memory SMS adapter with code retrieval through the integration harness. Configure a real provider and administrator MFA before enabling production startup.
- Setup and operator recovery return tokens for the API request bodies. Browser setup screens and delivery workflows belong to the demo UI segment.
- Practice status gates staff access. The sessions and bookings segment will add the running-session deactivation guard and record cleanup. The generated OpenAPI artifact remains pending.

## Sessions and bookings

- Committed the previous checkpoint on `main` as `eb1fe98` before starting this segment.
- Added scoped chamber and reference schedule settings. Date-specific overrides replace weekly hours, and drafts snapshot their own consultation interval, duration, and capacity. Staff explicitly publish drafts and control public booking availability.
- Added an active-practice directory, public available-session queries, scoped staff history, and patient-owned booking history. Booking identity comes from an authenticated patient profile or a patient login ID supplied by authorized staff. Shared contact numbers remain unrelated to ownership.
- Added transactional regular booking creation and cancellation. The transaction covers capacity, monotonic serials, waiting positions, idempotency results, and audit events. Staff must confirm the current capacity or overtime warnings against the current revision.
- Added the running-session guard and transactional deactivation cleanup. Disabling cancels future unfinished sessions, closes public booking on elapsed unfinished sessions, and makes waiting or missed bookings unserved. Reactivation preserves those outcomes.
- Extended the explicit migration and audited the existing identity collections alongside the new scheduling collections. The Scoop migration uses a temporary scoped user for the audit validator upgrade.

### Verification actually performed

- Upgraded the existing authenticated Scoop database with `pnpm --filter @practice/backend db:migrate:local`. A subsequent standard `db:migrate` succeeded with the app account.
- `pnpm check` passed lint, type checking, unit tests, and production builds with Turbo caching bypassed on the pinned toolchain.
- `pnpm --filter @practice/backend test:integration` passed on the authenticated replica set. Coverage includes date overrides and publication snapshots, cross-tenant access, the last-slot race, idempotency retries, cancellation and serial gaps, staff acknowledgement and stale revisions, the running-session guard, and a booking racing with deactivation.
- The compiled API reported ready, served the public practice directory, and required authentication for chamber settings on the migrated database. `git diff --check` passed.
- On Windows, `pnpm dev` served the Next.js preview at `http://127.0.0.1:3000`. The frontend origin also returned the API readiness response and the public practice directory through the proxy. The preview provides a connection check, and scheduling and booking workflows are available through the API.

### Limits at this checkpoint

- The integration harness seeds running, missed, and completed states where needed. The queue engine segment will add the public staff session lifecycle and queue transition commands, other insertion rules, and patient-facing ETA.
- Docker Compose and remote CI verification remain pending. A real SMS provider and administrator MFA are still prerequisites for production startup.

## Queue engine

- Added staff commands for session start and end, call-next, finish, miss, restore, move, and consultation duration changes. Special bookings use a separate staff route with optional priority reason and the existing overflow confirmation rules.
- Queue writes reuse the practice and assistant transaction guards and check the session revision. Commands, audit metadata, and their idempotency results commit together. The cancellation endpoint accepts an optional revision and preserves the previous request format.
- Added insertion and movement rules for special and returning slots. Serial numbers remain fixed, waiting positions describe serving order, and order changes preserve the other waiting slots' relative positions.
- Session closure marks waiting and missed slots unserved with the `session_ended` cause. Practice deactivation uses `practice_disabled`, and a running session prevents deactivation.
- Staff and patient queue snapshots read a single database snapshot. Staff see scoped patient details; patients see their own booking and estimate and anonymous surrounding slots while the queue is viewable. Estimates use current server time and show delayed consultations.
- The explicit migration extends the audit and idempotency validators while accepting existing bookings and audit events.

### Verification actually performed

- `pnpm check` passed lint, type checking, unit tests, and builds on the pinned toolchain with Turbo caching bypassed.
- `pnpm --filter @practice/backend test:integration` passed on the authenticated Scoop replica set. The suite covers published session lifecycle commands, mixed queue ordering, stale revisions, idempotent replays, concurrent call-next, the real start/deactivate race, patient DTO redaction, delayed and revised estimates, assistant revocation, and session closure with preserved booking outcomes.
- `pnpm db:check` passed. `db:migrate:local` upgraded the existing development database, and a subsequent standard `db:migrate` passed with the app account.
- The queue is available through REST snapshots and commands. Browser role screens and SSE transport belong to the next segment. Docker Compose and remote CI remain pending.

## Demonstration UI and live updates

- Committed the Queue engine checkpoint as `5928b32` before starting this segment.
- Replaced the browser preview with password sign-in, invitation activation, and role-specific workspaces. Administrators provision practices. Doctors and assistants configure sessions and operate the queue. Patients browse availability, reserve a slot, and follow their own wait estimate.
- Staff can configure chamber and reference hours, manage assistant invitations, register patients, confirm overflow, and act on the queue with revision-aware controls. Missed bookings appear separately with status text.
- Added authenticated SSE endpoints backed by a shared MongoDB change stream. Events prompt a fresh authorized snapshot and carry no patient or booking data. Session or identity changes and heartbeats recheck access. The browser retries streams and polls during interruptions.
- Documented the synthetic-data walkthrough from practice creation to session closure in README.md.

### Verification actually performed

- `pnpm check` passed lint, type checking, unit tests, and builds on the pinned toolchain.
- `pnpm db:check` and the authenticated replica-set integration suite passed. The SSE integration test verifies refresh-only frames after booking, access denial for an unbooked patient, closure after assistant revocation, and authoritative snapshots after reconnect.
- The local browser walkthrough used isolated synthetic fixtures in Edge on desktop and mobile. It exercised sign-in, provisioning, private setup links, chamber setup, session publication, patient booking, polling fallback, reconnection, staff call-next, consultation completion, and session closure.

### Limits at this checkpoint

- The browser demo uses password sign-in and invitation-based activation. SMS flows are available through the API, with test access through the in-memory adapter. Production startup requires real SMS delivery and administrator MFA.
- Docker Compose and remote CI verification remain pending.

## Hardening and operating documentation

- Added `pnpm test:smoke` for the built Next.js and Express processes on desktop Chromium and an emulated mobile viewport. Each run reserves a fresh synthetic database. Independent administrator, doctor and patient contexts exercise password sign-in and invitation activation, chamber setup, publication, booking, live queue updates, polling during a deliberate stream interruption, reconnection, consultation completion and session closure.
- Added [generated OpenAPI](openapi.json) for the REST and SSE endpoints using public Zod request and response contracts and an explicit route catalog. `pnpm check` checks route coverage and compares the saved spec with a fresh generation.
- Added the [operations runbook](OPERATIONS.md) for deploying the restricted synthetic demo, performing a quiesced backup and restoring into an empty database, clearing restored sessions and challenges, and validating a restored service. Wired the browser suites into the GitHub Actions job after the Compose integration tests.

### Verification actually performed

- Used Node `24.19.0` and pnpm `12.20.0`. `pnpm install --frozen-lockfile --offline`, `pnpm check` with Turbo cache bypassed, and a direct TypeScript check of the Playwright files passed. The generated document passed OpenAPI 3.1 validation.
- `pnpm db:check` and all authenticated replica-set integration tests passed on Scoop MongoDB. Those tests include recovery, tenant isolation, assistant revocation, transaction races and SSE authorization and reconnect.
- `pnpm test:smoke` passed on desktop and emulated mobile Chromium with the built apps on loopback and an authenticated Scoop smoke database.
- Stopped the smoke apps before using MongoDB Database Tools to make a compressed archive. Verified the SHA-256 checksum, previewed namespace mapping and restored into a separate synthetic database with zero document failures. Compared restored account, queue, booking and audit records, then cleared restored auth sessions and challenges.
- The built API started on the restored database using its existing validators and indexes. Fresh administrator sign-in and operator recovery let restored doctor and patient accounts read the ended session and completed booking. Recovery token replay was rejected. Migration and replica-set checks also passed on the restore target. The compiled API exited as expected in production mode with the existing SMS and MFA gate.
- Removed the temporary smoke and restore databases, scoped users, archive and credential files after the drill. Left the authenticated Scoop replica set available locally.
- Standalone Compose CLI configuration validation and local `actionlint` passed. The Compose CLI could not connect to a Docker engine. The repository has no configured Git remote for a hosted CI run.

### Limits and next starting point

- Run `pnpm db:up`, `pnpm db:check`, the integration suite and `pnpm test:smoke` on a Docker-enabled host. Verify the first hosted Actions run after a remote is configured.
- For an intended restricted preview, follow the operations runbook and repeat health, invitation, booking, queue streaming and closure checks from the real HTTPS origin. Local startup and restore were verified. Hosted proxy and provider-managed backup behavior still need verification on the chosen infrastructure.
- Keep using synthetic records and private invitation links. Real SMS delivery and administrator MFA remain production prerequisites.

## JWT login sessions

- Committed the pending hardening checkpoint as `e2a173b` before starting the requested JWT change.
- Replaced opaque login cookies with HS256 JWTs signed and verified by the pinned `jose` dependency. JWT verification checks algorithm, type, issuer, audience, required identity claims and expiry. The claims bind to the stored session identifier, account, credential version and expiration. Current database authorization and token hashes continue to enforce immediate logout, recovery and access revocation, including SSE.
- Added `JWT_SESSION_SECRET` configuration and documented stable signing keys, rotation and fresh sign-in after upgrading from opaque sessions. Generated a stable local key in the gitignored backend environment. Without configuration, development uses a per-process random key. Preserved HttpOnly/SameSite cookies, HTTPS Secure cookies and write-origin checks.
- Updated the accepted plan and generated OpenAPI cookie descriptions. Existing database documents and indexes remain compatible. Users with previous opaque session cookies must sign in again.

### Verification actually performed

- On the pinned Node and pnpm toolchain, `pnpm check` passed with Turbo cache bypassed, including JWT unit tests, lint, type checks and builds. OpenAPI generation checks and independent specification validation passed.
- `pnpm db:check` and the authenticated Scoop replica-set integration suite passed. Added HTTP assertions for JWT signature tampering, claim-to-session binding and immediate logout. Existing recovery, tenant isolation, assistant revocation and live queue tests passed using JWTs.
- Desktop and emulated mobile Chromium smoke projects passed against the built apps with synthetic fixtures. Removed the temporary smoke database and scoped credentials afterward. Preserved the pre-existing generated `frontend/next-env.d.ts` change byte for byte.

### Next starting point

- Configure the stable signing key on any intended preview host and use fresh sign-in after the JWT upgrade. Compose runtime, hosted CI and the actual HTTPS deployment checks listed above remain pending. Real SMS and administrator MFA remain production prerequisites.

## Patient and staff browser workflow refinement

- Added Dhaka service-date filtering and paging for patient availability and the practice directory. Added paging for staff sessions and booking history, with cursor resets when filters change.
- Staff can use the existing exact-login lookup to preview a patient's name before booking. Changing the ID clears the preview and pending overflow confirmation. New registrations populate the preview directly. Successful staff booking displays the assigned serial, and controls prevent overlapping lookup, registration and booking submissions.
- Prioritized an active queue above forms on mobile. Moved start/end controls beside queue operations, added queue counts and refresh timestamps, and made cancellation buttons distinguish the intended serial for assistive technology.
- Added explicit completed, missed, cancelled and unserved messages to the patient's queue and an explicit refresh control. Added retry controls for availability, sessions and staff history, and disabled staff writes when the last queue read failed.
- Extended the synthetic real-database browser walkthrough to cover date filtering, identity preview, staff booking, serial-specific cancellation and completed outcome text. Added response-fixture browser tests for later practice/session/history pages and filter resets.

### Verification actually performed

- `pnpm check` passed on pinned Node and pnpm with Turbo cache bypassed. Direct TypeScript checks of the browser test files and lint passed.
- `pnpm test:smoke` passed all desktop and emulated mobile Chromium projects. The workflow tests used a dedicated authenticated Scoop replica-set database. The pagination tests used synthetic API response fixtures. Removed the temporary database and scoped user afterward.
- Reviewed desktop and mobile screenshots of both workspaces. Browser assertions confirmed no horizontal page overflow. The Impeccable mechanical scan reported no findings.
- Preserved the original generated `frontend/next-env.d.ts` change byte for byte. Full backend integration tests were not rerun for this frontend-only segment. The real-database browser workflow exercised the existing booking and queue APIs.

### Next starting point

- The scoped browser refinement is complete. Deployment/Compose/hosted CI verification and production SMS/MFA prerequisites remain as recorded above. Choose the next segment before starting another feature area.

## Administrator seed diagnostics

- Investigated a failed manual seed command. Read-only checks confirmed that the configured local replica set was reachable, validators and indexes passed migration checks, and the `admin` login ID was available.
- Updated the seed CLI to identify invalid `SUPERUSER_*` inputs and distinguish connection, migration and creation failures. Messages omit supplied values and underlying driver errors. Existing administrator credentials remain unchanged on a repeat seed.
- Verified rejection of a short password and missing inputs, with field-specific messages. `pnpm check` passed with applicable Turbo cache hits. No administrator was created during these diagnostic runs. The user's terminal variables are not visible to this chat, so the original failing input remains unconfirmed.
- Preserved the pre-existing generated frontend change. Next, rerun the seed command in the user's Git Bash terminal with all seed variables exported and a password of the accepted length. Any remaining failure will identify its phase.

## Hosted CI and Docker Compose verification

- Reviewed the repository and hosted Actions results on 2026-11-25. The checkout was clean on `main` at `356952b`, with `origin` configured for `safayetdib/doctor-chamber-portal`. The latest commit contains the previously generated frontend type-reference update.
- Verified the completed [Checks run for that commit](https://github.com/safayetdib/doctor-chamber-portal/actions/runs/44269640453), which passed on 2026-11-18. Inspected both the job step conclusions and test summaries in its logs.
- The Ubuntu runner installed the frozen lockfile and passed `pnpm check`. Docker Compose started a healthy MongoDB container, initialized its replica set and passed `pnpm db:check`.
- The real replica-set integration suite passed all identity and scheduling tests, and the Chromium suite passed all desktop and emulated mobile workflow and navigation tests. Compose shutdown also succeeded.
- This closes the pending hosted CI and Compose runtime verification. Docker remains unavailable in the current Windows terminal. The Compose runtime result above comes from the hosted Ubuntu runner.
- Updated the checkpoint summary and operations runbook. This sitting changed documentation only. No application checks or deployments were started locally, and no workflow rerun was needed to inspect the completed result.

### Next starting point

- Verify a restricted synthetic preview through its intended HTTPS origin, including cookie scope, invitation activation, booking, SSE/polling and session closure. The hosting target and preview origin have not been selected in this repository.
- Real SMS delivery and administrator MFA remain production prerequisites. Further application features need a selected scope.
