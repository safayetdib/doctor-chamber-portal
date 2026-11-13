# Practice management — Version 1 implementation plan

Status: accepted design; implementation is tracked in `PROGRESS.md`.

## Intent and scope

Build the chamber queue first. Prioritize backend correctness and a maintainable repository; the Next.js frontend only needs to demonstrate the workflows. The conversation's decisions override the broader Doctor Practice Management System specification supplied by the product owner.

Include account activation, ID/password authentication, optional account-specific phone login, admin-managed paid practice access, doctor-invited assistants, a single chamber and optional assistant per doctor, reference schedules, explicitly published dated sessions, bookings, live anonymous patient queues, staff queue operations, estimates, audit history and concurrency protection.

Defer prescriptions and clinical records, payments and automatic subscription billing, queue SMS notifications, offline writes, automatic recurring-session generation, multi-chamber practices, multiple assistants and polished visual design. Patient identifiers must remain suitable for future prescription records.

## Architecture

- TypeScript throughout; pnpm workspaces and Turborepo.
- Top-level `frontend/` (Next.js App Router, React) and `backend/` (Express modular monolith).
- `packages/contracts/` contains public Zod request/response validation and inferred types, never database models or credentials.
- MongoDB official Node driver; replica set in development/test/production for transactions and change streams.
- Routes -> validation/authentication -> application services -> repositories. Backend owns all business rules.
- Separate frontend/backend processes, same-origin `/api/*` routing. No duplicate Next.js business backend.
- SSE signals and authoritative snapshots, polling fallback, no offline writes. No initial Redis or message broker.
- Pin a supported Node LTS release, package manager and dependencies; commit the lockfile.
- Vitest, Supertest, real replica-set integration tests; a small Playwright demonstration suite later.

## Accounts and permissions

Each patient has a separate account and permanent patient ID, even when sharing a phone. Required registration fields are name and contact phone; other demographics are optional. Never merge by name/phone. Internal account ID, human-readable login ID and patient ID are distinct.

| Capability | Doctor | Assigned assistant | Patient | Superuser |
| --- | --- | --- | --- | --- |
| Configure chamber, reference hours and sessions | Own practice | Assigned practice | No | No routine editing |
| Register patients and create bookings | Yes | Yes | Own account | No |
| Operate/reorder queue; add special slots | Yes | Yes | No | No |
| Cancel booking | Own practice | Assigned practice | Own eligible booking | No |
| Invite/revoke assistant | Yes | No | No | No |
| Create/enable/disable doctor practice | No | No | No | Yes |
| View patient identity | Own practice | Assigned practice | Own account | No routine access |

- Public patients verify contact phone by signup OTP, then use ID/password. Verification does not enable phone login.
- Staff can register and book a patient before activation or OTP verification. Provide an expiring single-use link to choose a password; no staff-known permanent password.
- Admin creates paying doctors; no public doctor signup. Doctor alone generates assistant setup links.
- Primary authentication for all roles is ID/password. User explicitly enables phone login after authentication and OTP verification. Secondary login requires that account's login ID plus OTP to its authorized number; no shared-phone account listing.
- Contact phone and authorized login phone are separate. Changing contact details does not grant access.
- Activated users manage their own identity; staff may correct pre-activation registration details and manage booking details.
- Staff searches are practice-scoped. A patient-provided login ID may be used for minimal identity lookup to book an existing patient, never to access another practice's history.
- Argon2id hashes, opaque hashed server session tokens, HttpOnly secure cookies, CSRF/origin controls, request throttling and session revocation.
- Recovery uses explicitly authorized phone, otherwise an audited operator-assisted process. Contact number alone is insufficient.
- Setup links cannot reset activated accounts. Revocation applies immediately to REST and live access.
- Idempotent superuser CLI seed with explicit secrets, no default credentials or public registration. Additional MFA for production administration.
- Fake SMS adapter only in development/tests/demo; production must reject it.

## Database conventions

ObjectId internally; validated string IDs in API. BSON UTC dates serialized as ISO timestamps. Use Asia/Dhaka for local scheduling/display. Reference hours use weekdays/local wall-clock times. Derive types from runtime schemas; validate persisted documents as well as requests. Ownership and audit fields are server-assigned. Records are not hard-deleted as routine corrections.

Enums:

```ts
type Role = 'patient' | 'doctor' | 'assistant' | 'superuser';
type AccountStatus = 'pending_setup' | 'active' | 'disabled';
type PracticeStatus = 'active' | 'disabled';
type AssistantAccessStatus = 'invited' | 'active' | 'revoked';
type SessionStatus = 'draft' | 'scheduled' | 'running' | 'ended' | 'cancelled';
type BookingStatus = 'waiting' | 'in_progress' | 'done' | 'missed' | 'cancelled' | 'unserved';
type QueueClass = 'regular' | 'returning' | 'special';
```

### Identity/access collections

All mutable records include creation/update timestamps where applicable.

| Collection | Fields / constraints |
| --- | --- |
| accounts | loginId (normalized unique), role (fixed in V1), name, contactPhone (nonunique), contactPhoneVerifiedAt, status, createdByAccountId; optional createdByDoctorId for staff registrations |
| credentials | accountId (unique), passwordHash after activation, passwordChangedAt, authVersion; optional independently verified phone-login grant |
| authSessions | accountId, unique token digest, authVersion, expiresAt, revokedAt; TTL cleanup |
| authChallenges | purpose, account/signup target, token/code digest, expiresAt, attempt count, consumedAt, purpose-specific payload; TTL cleanup; check expiration in application, not just TTL |
| patientProfiles | accountId (unique); `_id` is permanent patientId; optional birth date, gender, address |
| doctorProfiles | accountId (unique), public display name, optional specialty/registration, practiceStatus, accessRevision, disable metadata |
| assistantAssignments | doctorId, assistantAccountId, status, inviter, invitation/acceptance/revocation times, revision; partial uniqueness per doctor and assistant for invited/active assignments |

### Practice/session collections

| Collection | Fields / constraints |
| --- | --- |
| chambers | doctorId (unique), name, address, contact phone, timezone, default consultation minutes |
| referenceSchedules | doctorId (unique), weekly intervals, dated overrides, default consultation minutes and capacity |
| sessions | doctorId, chamberId, local service date, timezone, startsAt, endsAt, consultationMinutes, capacity, bookingOpen, status, actual start/end, lastSerialNumber, capacityUsed, queueRevision |

- Reference hours pre-fill sessions but never constrain staff or automatically publish sessions. Dated overrides replace the reference hours for that date.
- Session settings are snapshots. Later reference changes do not rewrite existing sessions.
- Positive integer capacity/duration; end after start. Multiple dated sessions allowed; only one running session per doctor (partial unique index).
- Index doctor/start time and public availability.

### bookings (also the queue slot)

Fields: `_id`, doctorId, chamberId, sessionId, patientId, serialNumber, status, queueClass, queuePosition (integer or null), source (patient/staff), createdByAccountId, optional priorityReason, patientSnapshot (name/contactPhone), startedAt, completedAt, cancelledAt, lastMissedAt, lastRestoredAt, unservedAt, unservedCause (session_ended/practice_disabled/null), timestamps.

- Unique `(sessionId, serialNumber)`; numbers increase and are never reused.
- Partial unique `(sessionId, patientId)` for waiting/in_progress/missed/done; cancelled patients can rebook with a new serial.
- Partial unique sessionId for in_progress.
- Query indexes: `(sessionId,status,queuePosition)`, `(doctorId,patientId,createdAt)`, `(patientId,createdAt)`.
- Only waiting slots have queuePosition; serving order is independent of permanent serial.
- Special is classification, not status. Snapshot is not proof of ownership.
- All references must agree on practice/session/chamber. Service enforces relationships MongoDB cannot enforce as foreign keys.
- Capacity counts noncancelled bookings, including missed/done. Cancellation frees capacity; completion/missing does not.
- Unserved is terminal; no automatic revival.

### Supporting collections

- auditEvents: actor, doctor scope, entity/action/time/request ID, minimal changes. Append-only; no tokens/passwords/OTPs. Record transitions, reorders, priority creator, invitations and access changes.
- idempotencyRecords: actor, operation scope, key, payload hash, committed result, expiry. Same key/payload returns original result; changed payload rejected.
- rateLimitBuckets: atomic counters with expiry for authentication/signup/booking abuse controls.

Use explicit migration scripts for validators/indexes; do not silently synchronize destructive schema changes on application startup.

## Sessions, queue and estimates

Public booking requires active practice, published unfinished session, bookingOpen, remaining capacity and server time before scheduled end. Booking is allowed during a running session. Staff may continue outside reference hours and after scheduled end while session is unfinished.

At full capacity, reject patient booking. Staff receive a confirmation prompt for capacity exceeded and/or estimated finish beyond session end. After acknowledgement create a regular booking, without mandatory reason or special classification; recheck the revision before committing.

| Command | Transition |
| --- | --- |
| Book | new -> waiting |
| Call next | first waiting -> in_progress |
| Finish | in_progress -> done |
| Mark missed | waiting/in_progress -> missed |
| Restore | missed -> waiting |
| Cancel | waiting/missed -> cancelled |
| End session | remaining waiting/missed -> unserved |

- No check-in requirement. Both doctor/assistant operate queue and assign special slots without per-action permission; reason optional, actor recorded.
- Finish current consultation before ending session. Scheduled end closes public booking, not the running session.
- Patients cancel only their own waiting/missed bookings in unfinished sessions.
- Missed slots are displayed separately using text/status and muted styling, not color alone.
- Regular insertion: append. Special insertion: after last waiting special, else front. Restored ordinary insertion: after last special/returning, else front. Existing relative order remains intact.
- Restore missed special slots as special; ordinary ones become returning. Preserve restoration order.
- Staff can move waiting slots freely through buttons/drag-and-drop; current slot is not moved/interrupted. Use `move booking before target booking`, null target for end. Never continuously re-sort manual moves.
- Queue class and queue position remain distinct.

ETA: before session starts use max(now,scheduled start); during consultation use max(0, configured duration minus elapsed time), then add configured duration for waiting slots ahead. Exclude terminal/missed slots. Derive estimates rather than storing them per booking. Include server/calculation time, label estimates, indicate delayed current consultations. Recompute on changes and periodic refresh. Duration edits affect remaining estimates, not recorded timestamps.

Patients see anonymous serials/statuses/special badges, serving order and their own estimate; no other patient IDs/names/contact details, priority reasons or staff notes. Staff and patient DTOs are separate allowlists.

## Deactivation

Admin manually controls paid access; payments happen outside system. Reject deactivation while session runs. Hide disabled practice and reject new bookings. Cancel unfinished future sessions; mark waiting/missed slots unserved with practice_disabled cause. Preserve read-only history. Reactivation does not restore affected sessions/bookings. Assistant operational access depends on practice status.

## API and concurrency

REST `/api/v1`: auth, admin practices, chamber/reference settings, assistant invitations, patients, sessions, bookings, queue snapshots/events/commands. Shared Zod schemas and generated OpenAPI.

Queue commands include expectedRevision; retriable mutations include Idempotency-Key. Typed errors include SESSION_FULL, OVERTIME_CONFIRMATION_REQUIRED, STALE_QUEUE, PRACTICE_DISABLED, INVALID_TRANSITION.

- Transactions commit serial/capacity allocation, booking, idempotency and audit together.
- Serialize mutations through session queueRevision; update integer waiting positions transactionally. No unique position index that would collide during swaps.
- Practice mutations touch doctor accessRevision so start/deactivate/book cannot race unnoticed. Assistant operations similarly guard assignment revision.
- Concurrent call-next cannot start different patients. Stale mutations refresh; no silent overwrite.
- Transaction callbacks may retry: no SMS/external effects inside them, no parallel driver operations within a transaction.
- Snapshots must be internally consistent. Change streams signal a refresh after commit; polling/reconnect read authoritative state. Recheck subscription access.

## Infrastructure and verification

Validated environment config; local replica-set containers; explicit migrations; structured redacted logs/request IDs; liveness/readiness; graceful shutdown; CI lint/typecheck/tests/build; backup/restore instructions. No secrets in git or task cache.

Acceptance scenarios: shared-phone isolation; activation expiry/replay; verification separate from phone login; tenant isolation/revocation; concurrent booking capacity/uniqueness; cancellation and serial gaps; acknowledged staff overflow; concurrent call-next; manual/default insertion; missed/special restoration; stale reorder rollback; start/deactivate race; Unserved causes; ETA edge cases; redacted patient DTOs; restart/retry/reconnect correctness; end-to-end booking through session closure and deactivation.

## Delivery segments

1. Repository foundation: workspace, contracts scaffold, API health/config/database, Next shell, replica set config, CI and base checks.
2. Accounts/access: schemas/indexes, auth/setup, superuser, doctor administration, assistant assignment.
3. Sessions/bookings: chamber/reference schedules, publish sessions, registration, capacity/cancellation.
4. Queue engine: transitions, insertion/reorder, ETA, transactions/audit/idempotency.
5. Demo UI/live updates: thin role screens, functional forms/tables/move buttons, live snapshots and reconnect.
6. Hardening: real database integration/concurrency/security tests, deployment/backup docs and full demo.

At each checkpoint, verify the segment and update PROGRESS.md with checks, limitations and the next exact starting point. Do not implement later segments in the same sitting unless requested.
