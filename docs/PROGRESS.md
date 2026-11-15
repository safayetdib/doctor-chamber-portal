# Implementation checkpoints

The accepted specification is [PLAN.md](PLAN.md). This file is the handoff between sittings.

| Segment | Status |
| --- | --- |
| Repository foundation | Implemented and verified against an authenticated Scoop replica set |
| Accounts and access | Backend implemented with local replica-set verification |
| Sessions and bookings | Not started |
| Queue engine | Not started |
| Demonstration UI and live updates | Not started |
| Hardening and operating documentation | Not started |

## Completed in the foundation sitting

- Saved the accepted plan before implementation and initialized a local Git repository on `main`. Files remain uncommitted; no remote was configured.
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

## Start here next sitting

1. Read PLAN.md and this handoff. Select the pinned Node version and start the Scoop replica set with `./infra/start-mongodb.ps1` or use the documented Compose workflow.
2. Build contracts, run `pnpm db:check` and `pnpm --filter @practice/backend db:migrate`, then run `pnpm --filter @practice/backend test:integration` as an identity baseline.
3. Begin **Sessions and bookings** with chamber and reference schedule documents, migrations and authorized routes, then dated session drafts and explicit publication in Asia/Dhaka.
4. Use the existing identity service and practice guards for staff and patient booking. Add transactionally allocated serials and capacity, ownership checks, cancellation, deactivation guards and cleanup, plus live replica-set coverage for races. Keep queue operation commands and demo UI for their own segments.
