# Practice management

Backend-first chamber queue application. The accepted design is in [docs/PLAN.md](docs/PLAN.md); session-to-session status is in [docs/PROGRESS.md](docs/PROGRESS.md).

## Prerequisites

- Node.js matching `.node-version` (supported LTS).
- pnpm matching the root `packageManager` field.
- A writable MongoDB replica set. Use Scoop on Windows or Docker Compose for the container setup.

## Local setup

### Windows with Scoop

Install dependencies and start MongoDB from the repository root in PowerShell. Leave this terminal open while developing. Use Ctrl+C to stop MongoDB.

```powershell
pnpm install --frozen-lockfile
scoop install main/mongodb
./infra/start-mongodb.ps1
```

From a second terminal at the repository root, initialize the replica set on first use, verify it, and start the apps.

```powershell
pnpm --filter @practice/backend db:init:local
pnpm db:check
pnpm --filter @practice/contracts build
pnpm --filter @practice/backend db:migrate:local
pnpm dev
```

The initializer generates an app password and saves it as part of `MONGODB_URI` in the gitignored `backend/.env`. The app user has `readWrite` access to `practice_management`. The gitignored `.mongodb-local/` directory holds the replica key, user administrator password, data, and server log. On subsequent starts, run `./infra/start-mongodb.ps1` and then `pnpm dev`. The Scoop and Compose setups both use localhost port 27017, so stop one before starting the other.

### Docker Compose

From the repository root on macOS or Linux, run the following. In PowerShell, use `Copy-Item` in place of `cp`.

```sh
pnpm install --frozen-lockfile
cp backend/.env.example backend/.env
pnpm db:up
pnpm db:check
pnpm --filter @practice/contracts build
pnpm --filter @practice/backend db:migrate
pnpm dev
```

### Open the app

Open http://127.0.0.1:3000. The frontend proxies `/api/*` to the backend on http://127.0.0.1:4000. The API requires a writable replica set and the explicit database migration. If the sign-in screen reports that the service is unavailable, check `pnpm db:check` and retry the connection.

For simultaneous editing, root `pnpm dev` watches contracts and applications. After changing shared contracts, restart an app if its watcher does not pick up rebuilt workspace output.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run applications and contract watcher |
| `pnpm check` | Lint, typecheck, tests and production builds |
| `pnpm db:up` | Start and initialize the Compose replica set |
| `pnpm db:check` | Validate connection and writable replica-set topology |
| `pnpm --filter @practice/backend db:migrate` | Apply collection validators and indexes |
| `pnpm --filter @practice/backend db:migrate:local` | Apply migrations to the authenticated Scoop database using a temporary migration account |
| `pnpm --filter @practice/backend seed:superuser` | Create a development administrator from explicit env inputs |
| `pnpm --filter @practice/backend test:integration` | Run identity, scheduling, and booking tests in isolated collections on a writable development replica set |
| `pnpm test:smoke` | Run the browser workflow against the built apps and a dedicated replica-set database |
| `pnpm openapi:generate` | Regenerate the OpenAPI document from public contracts and the route catalog |
| `pnpm db:down` | Stop the Compose database, preserving its volume |
| `pnpm --filter @practice/backend start` | Run previously built API |
| `pnpm --filter @practice/frontend start` | Run previously built frontend |

Liveness: `/api/v1/health/live`. Readiness: `/api/v1/health/ready` (unavailable when database checks fail). Health responses do not expose credentials or database addresses.

## Development boundaries

- `frontend/`: presentation only; no database access.
- `backend/`: validated environment, persistence, identity, scheduling, and booking services.
- `packages/contracts/`: public runtime schemas and TypeScript types, no credential or database exports.
- `infra/`: local-only MongoDB setup. The unauthenticated container is bound to loopback and is not a production deployment configuration.
- CI repeats the checks and verifies the Compose replica set on Linux.

## Accounts and access

To seed a local administrator, supply `SUPERUSER_LOGIN_ID`, `SUPERUSER_NAME`, and `SUPERUSER_PASSWORD` to the seed command through the process environment or your gitignored `backend/.env`. Choose an explicit password. A repeat seed for the same active administrator leaves the existing credentials unchanged.

The identity API is under `/api/v1`. For direct API testing, send the configured `PUBLIC_APP_ORIGIN` as the `Origin` header on writes and reuse the session cookie returned by login or setup. The local HTTP origin defaults to `http://127.0.0.1:3000`, and an HTTPS origin uses a Secure cookie.

| Workflow | Routes |
| --- | --- |
| Password login and session | `POST /auth/login`, `GET/PATCH /auth/me`, `POST /auth/logout` |
| Patient self-signup or invited setup | `POST /auth/signup/start`, `POST /auth/signup/complete`, `POST /auth/setup` |
| Optional phone sign-in | `POST /auth/phone-grant/start`, `POST /auth/phone-grant/complete`, `DELETE /auth/phone-grant`, `POST /auth/phone-login/start`, `POST /auth/phone-login/complete` |
| Recovery with an authorized phone | `POST /auth/recovery/start`, `POST /auth/recovery/complete` |
| Operator-assisted recovery | `POST /admin/account-recovery`, `POST /auth/recovery/operator/complete` |
| Practice administration | `GET/POST /admin/practices`, `GET /admin/practices/:doctorId`, `PATCH /admin/practices/:doctorId/status`, `POST /admin/practices/:doctorId/setup` |
| Assigned practice and assistant management | `GET /practice`, `GET/POST /practice/assistant`, `POST /practice/assistant/:assignmentId/setup`, `DELETE /practice/assistant/:assignmentId` |
| Staff patient registration | `POST /patients`, `POST /patients/lookup`, `PATCH /patients/:patientId`, `POST /patients/:patientId/setup` |

Send setup invitations privately. The browser displays a setup link after creating an invitation. Its token is carried in the URL fragment and submitted in the setup request body.

For an account without an authorized phone, an administrator can issue an operator recovery token after independently confirming the caller's identity. Record the approved case outside the application and send an opaque `caseReference` of the form `CASE-ABC123` with the login ID and the administrator's current password. Deliver the token through the verified private channel. The issuance and completion audit events link to that case reference.

The development SMS adapter stores codes in memory for retrieval through the integration harness. Set `IDENTITY_OTP_SECRET` in the gitignored environment to keep outstanding codes verifiable over a development restart. An unset value uses a per-process secret. Production startup is gated on a real SMS provider and administrator MFA.

## Sessions and bookings

| Workflow | Routes under `/api/v1` |
| --- | --- |
| Staff configure their practice | `GET/PUT /practice/chamber`, `GET/PUT /practice/reference-schedule`, `GET /practice/reference-schedule/prefill/:date` |
| Staff prepare and publish sessions | `GET/POST /practice/sessions`, `PATCH /practice/sessions/:sessionId`, `POST /practice/sessions/:sessionId/publish`, `PATCH /practice/sessions/:sessionId/booking-open` |
| Browse public availability | `GET /practices`, `GET /practices/:doctorId/sessions` |
| Create and cancel bookings | `POST /sessions/:sessionId/bookings`, `DELETE /bookings/:bookingId` |
| Read booking history | `GET /bookings` for the patient, `GET /practice/sessions/:sessionId/bookings` for authorized staff |

Staff draft sessions with a local `serviceDate`, `startTime`, and `endTime` in Asia/Dhaka, and can supply an `endDate` for an overnight session. Session times in responses use UTC ISO timestamps. Reference schedules supply defaults through the prefill endpoint. Publishing and editing use the session's `queueRevision` as `expectedRevision`.

Use an `Idempotency-Key` header for booking creation and cancellation. Patients send an empty JSON object to book for themselves. Staff send `patientLoginId`, including for patients they preregistered. When the response asks for confirmation, use its warning codes and revision in `confirmation.acknowledged` and `confirmation.expectedRevision`. Repeat a committed request with the original key and payload to retrieve its original result.

### Migrating an existing database

Migrations extend the existing audit and idempotency collection validators. On Scoop, run `db:migrate:local` after building contracts. On another authenticated replica set, supply a scoped migration credential with collection management privileges in `MONGODB_MIGRATION_URI` when running `db:migrate`. The backend continues to use `MONGODB_URI` for app access.

## Queue engine

| Workflow | Routes under `/api/v1` |
| --- | --- |
| Read the staff queue | `GET /practice/sessions/:sessionId/queue` |
| Read the patient's queue and estimate | `GET /sessions/:sessionId/queue` |
| Operate the queue | `POST /practice/sessions/:sessionId/queue/commands` |
| Add a special booking | `POST /practice/sessions/:sessionId/queue/special-bookings` |

Staff commands take an `Idempotency-Key` header and an `expectedRevision` from the staff queue snapshot. Use `action` values `start`, `end`, `call-next`, `finish`, `miss`, `restore`, `move`, or `set-duration`. Booking-specific commands take `bookingId`. A move takes `beforeBookingId`, with `null` for the end of the line. Duration changes take `consultationMinutes`. Refresh the snapshot before resubmitting a stale command. The booking cancellation route also accepts an optional `expectedRevision`.

The special booking route takes the revision, `patientLoginId`, and an optional `priorityReason`. If the API returns capacity or overtime warnings, submit those codes in `acknowledged` with the latest revision. The regular booking route continues to create regular bookings when staff confirm overflow.

Patients with a booking can read their own outcome. During a viewable session, the surrounding queue uses anonymous serials and status badges. Estimates use the consultation start, running duration, and current waiting order at `calculatedAt`.

### Walk through the browser demo

1. Start the local stack. If you need a first administrator, supply the seed inputs described above and run `pnpm --filter @practice/backend seed:superuser`.
2. Sign in as the administrator. Create a practice and open the doctor's setup link in a separate browser profile or private window. Choose a password.
3. As the doctor, save a chamber under **Practice settings**. Return to **Sessions**, create a dated draft, and publish it. Choose a scheduled end in the future so patients can book it.
4. Under **Book a patient**, expand **Register a new patient** and issue an invitation with synthetic details. Activate the patient in a browser profile separate from the doctor. In the patient workspace, pick the practice and book the session. Staff can also book against the patient's login ID.
5. As the doctor, start the session and call the next patient. The patient screen refreshes automatically. Finish the consultation and end the session, then check the completed booking in history.

Staff and patient queue APIs provide authenticated `/events` endpoints alongside their snapshots. The events signal when to refetch and carry no booking data. The browser polls while disconnected and retries the stream. A separate browser profile per role keeps the sessions independent.

## Operational notes

The Compose member advertises `mongo:27017` inside the container network. Host applications use `directConnection=true` to reach it through the loopback port. The Scoop replica set advertises `localhost:27017` and requires authentication.

When moving to an Atlas replica set, configure an Atlas database user and network access, set `MONGODB_URI` to the Atlas-provided `mongodb+srv://` URI, and set `MONGODB_DB` to the application database name. Run `pnpm db:check` against the new connection. Copy any local data you want to keep separately. [Atlas driver connection guide](https://www.mongodb.com/docs/atlas/driver-connection/)

`API_INTERNAL_ORIGIN` is consumed by Next.js rewrites at build/start configuration time. Set it consistently in the deployment build environment. No `NEXT_PUBLIC` variable contains private backend configuration.

Use synthetic patient data. See the [operations runbook](docs/OPERATIONS.md) for restricted demo deployment, backup/restore and automated browser verification, and [OpenAPI](docs/openapi.json) for the generated API reference.
