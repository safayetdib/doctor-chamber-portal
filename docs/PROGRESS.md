# Implementation checkpoints

The accepted specification is [PLAN.md](PLAN.md). This file is the handoff between sittings.

| Segment | Status |
| --- | --- |
| Repository foundation | Implemented; application checks passed, live database check pending local Docker |
| Accounts and access | Not started |
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

## Start here next sitting

1. Read PLAN.md and this handoff; retain the accepted scope.
2. Make Docker available (or provide an authenticated development replica-set URI), copy environment examples, then run `pnpm db:up` and `pnpm db:check` to close the infrastructure verification gap. The Compose database is local-only and unauthenticated.
3. Begin **Accounts and access**: persisted schemas/validators/index migrations, account/credential/profile repositories, authentication/setup challenges, superuser seed, doctor administration and assistant invitations/revocation.
4. Add database integration tests alongside identity/access work. Do not postpone permission and uniqueness checks until the final hardening segment.
5. Continue using a development-only SMS adapter until a real provider is selected/configured; never allow the fake adapter in production.

Do not start sessions/bookings or queue implementation until the accounts/access checkpoint is complete. Frontend polish remains deferred.
