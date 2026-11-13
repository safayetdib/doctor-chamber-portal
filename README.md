# Practice management

Backend-first chamber queue application. The accepted design is in [docs/PLAN.md](docs/PLAN.md); session-to-session status is in [docs/PROGRESS.md](docs/PROGRESS.md).

## Prerequisites

- Node.js matching `.node-version` (supported LTS).
- pnpm matching the root `packageManager` field.
- Docker with Docker Compose for the local MongoDB replica set. A standalone MongoDB server is insufficient.

## Local setup

From the repository root:

```powershell
pnpm install --frozen-lockfile
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env.local
pnpm db:up
pnpm db:check
pnpm dev
```

Use `cp` instead of `Copy-Item` on macOS/Linux. Environment files contain local defaults only; never commit real credentials.

Open http://127.0.0.1:3000. The frontend proxies `/api/*` to the backend on http://127.0.0.1:4000. The API intentionally refuses to start without a writable replica set. To preview only the frontend, run `pnpm --filter @practice/contracts build`, then `pnpm --filter @practice/frontend dev`; its service check will accurately show unavailable until the backend runs.

For simultaneous editing, root `pnpm dev` watches contracts and applications. After changing shared contracts, restart an app if its watcher does not pick up rebuilt workspace output.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run applications and contract watcher |
| `pnpm check` | Lint, typecheck, tests and production builds |
| `pnpm db:up` | Start local replica set and initialize it |
| `pnpm db:check` | Validate connection and writable replica-set topology |
| `pnpm db:down` | Stop local database, preserving its volume |
| `pnpm --filter @practice/backend start` | Run previously built API |
| `pnpm --filter @practice/frontend start` | Run previously built frontend |

Liveness: `/api/v1/health/live`. Readiness: `/api/v1/health/ready` (unavailable when database checks fail). Health responses do not expose credentials or database addresses.

## Development boundaries

- `frontend/`: presentation only; no database access.
- `backend/`: validated environment, API, infrastructure and future domain services.
- `packages/contracts/`: public runtime schemas and TypeScript types, no credential or database exports.
- `infra/`: local-only MongoDB setup. The unauthenticated container is bound to loopback and is not a production deployment configuration.
- CI repeats the checks and verifies the Compose replica set on Linux.

No authentication, booking or queue domain endpoints exist in the foundation segment. See the progress document before starting the next segment.

## Operational notes

The local MongoDB member advertises `mongo:27017` inside Compose; host applications use `directConnection=true` to the loopback port. Production must use an authenticated replica-set URI with reachable member hostnames and without this local-only topology workaround.

`API_INTERNAL_ORIGIN` is consumed by Next.js rewrites at build/start configuration time. Set it consistently in the deployment build environment. No `NEXT_PUBLIC` variable contains private backend configuration.

Database migrations, authentication, SMS provider integration, backups and deployment hardening are planned in later segments; do not use this foundation with real patient records.
