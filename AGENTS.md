# Repository working agreement

- Read `docs/PLAN.md` and `docs/PROGRESS.md` before changing this project. The plan captures product decisions; the progress file is the cross-session handoff.
- Work on the current requested segment only. Do not silently expand into later segments.
- Preserve the top-level frontend/backend separation. Public DTOs and validation belong in `packages/contracts`; backend credentials and persistence documents must not be exported there.
- Backend authorization and transaction guards are authoritative. UI hiding is never permission enforcement.
- Never identify, merge or authorize patient accounts by contact phone alone. Serial numbers and queue positions are distinct.
- Use the pinned Node/pnpm toolchain. Run `pnpm check` for foundation changes; use real replica-set integration tests when changing database/domain behavior.
- Before completing a sitting, update `docs/PROGRESS.md` with changes, actual verification, limitations and the next starting point. Do not report unrun checks as passing.
- Never commit secrets or real patient records. The Compose database is local-only.
