# Operating the chamber queue prototype

## Verification checkpoint

The [hosted Checks run for commit `356952b`](https://github.com/safayetdib/doctor-chamber-portal/actions/runs/44269640453) passed on 2026-11-18 and was reviewed on 2026-11-25. It verified the frozen dependency installation, workspace checks, Docker Compose replica-set startup and readiness, database integration tests, desktop/mobile browser tests and database shutdown on Ubuntu.

The synthetic browser tests used the built apps over loopback. Verification through an intended hosted HTTPS origin and its proxy still needs to be performed on the selected preview infrastructure.

## Deploy a restricted synthetic demo

Use the pinned Node and pnpm versions, a private authenticated MongoDB replica set with a writable primary, and separate API and frontend processes. The local Compose configuration is for disposable development and CI. Keep the demo behind an access-controlled preview or on loopback and use synthetic accounts and patient records. The API currently exits in production mode. Real SMS delivery and administrator MFA are required before a public or clinical deployment.

1. Install from the lockfile with `pnpm install --frozen-lockfile`. Set `API_INTERNAL_ORIGIN` to the API listener, such as `http://127.0.0.1:4000`, and run `pnpm build`. Supply the same value at frontend startup. The frontend uses a same-origin Next.js rewrite for `/api/*`.
2. Inject environment variables through each process supervisor. For the isolated demo API use `NODE_ENV=development`, `HOST=127.0.0.1` and `PORT=4000` when both processes share a host. Set `PUBLIC_APP_ORIGIN` to the exact browser origin including scheme and any non-default port, without a trailing slash. Use HTTPS for a network-accessible preview so the session cookie is Secure. Supply the app user's `MONGODB_URI`, `MONGODB_DB` and a random secret of at least 32 characters for `IDENTITY_OTP_SECRET`. Scope app credentials to the application database.
3. Run `pnpm db:check`. Run `pnpm --filter @practice/backend db:migrate` as a separate release step with the target database and, where needed, the scoped `MONGODB_MIGRATION_URI` credential for collection management. On the Scoop development database use `db:migrate:local` for existing validator upgrades. The API checks migrations when it starts. Remove the migration credential from the app's runtime environment.
4. For a fresh demo, seed the administrator with `pnpm --filter @practice/backend seed:superuser` using explicit `SUPERUSER_LOGIN_ID`, `SUPERUSER_NAME` and `SUPERUSER_PASSWORD`. Give the password and invitation links to the intended recipients through a private channel. Run the seed command separately from the long-running processes.
5. Start `pnpm --filter @practice/backend start` and `pnpm --filter @practice/frontend start` under a process supervisor. The frontend start command binds to loopback. Use a private network listener if deploying the processes on separate hosts. Route the preview through one HTTPS origin and preserve the browser's `Origin` header on API writes. Disable response buffering and caching on queue event streams. Set the proxy idle timeout above the API's 15-second refresh interval. [Next.js self-hosting and streaming guide](https://nextjs.org/docs/app/guides/self-hosting#streaming-and-suspense)
6. From the served origin, check `/api/v1/health/live` returns `ok` and `/api/v1/health/ready` returns `ready`. Then run the [synthetic browser walkthrough](../README.md#walk-through-the-browser-demo) on that origin to verify login, cookie scope, public booking, live updates and session closure through the actual proxy. The automated smoke suite starts its own local stack. Use the API's `X-Request-Id` to correlate errors with logs.

During rollout, drain traffic and let the API handle service termination so it can close event streams and database connections. If startup or readiness fails, check connectivity, writable-primary election and the migration result. A live process may still be unready. Take a verified backup before a schema change. Restore into a separate database if a rollback needs the old schema, and point the previous build at that recovered database only after validation.

## Back up and restore

Use compatible [MongoDB Database Tools](https://www.mongodb.com/docs/database-tools/installation/) and a source and target on compatible MongoDB versions. Keep archives and their checksums in access-controlled encrypted storage with the timestamp, database name, application revision and MongoDB version. Backups include identity and queue history. Use a restricted working directory outside the repository and keep credentials in restricted config files supplied to `--config`. Each config file is YAML with a `uri` entry. Protect it and delete the temporary copy after the exercise. Use a backup user with read access to the source database and a restore user with collection, index and write privileges on the empty target. Provision target users, secrets and replica-set infrastructure separately.

1. Close active sessions where practical. Stop all API writers and any other process that writes to the source database, including migration and seeding jobs. Keep them stopped for the entire dump. A database-scoped logical dump does not capture concurrent writes in an oplog. Expired TTL records can disappear independently of application writes. Use the provider's snapshot and point-in-time recovery facilities if the operating environment requires backup while writes continue. [MongoDB backup consistency guidance](https://www.mongodb.com/docs/manual/tutorial/backup-and-restore-tools/)
2. In the secure working directory, dump the database to a new archive. The examples use a POSIX shell. In PowerShell set variables as `$sourceDb = 'practice_management'` and use `Get-FileHash -Algorithm SHA256 $archive` for the checksum.

   ```sh
   sourceDb=practice_management
   restoredDb=practice_restore_drill
   archive=practice-management-YYYYMMDDTHHMMSSZ.archive.gz
   mongodump --config=backup.yml --db="$sourceDb" --gzip --archive="$archive"
   sha256sum "$archive" > "$archive.sha256"
   ```

   Confirm the dump exit status before recording the checksum or resuming application writes. Treat the archive as invalid if the dump fails. [MongoDB dump options](https://www.mongodb.com/docs/database-tools/mongodump/)
3. Verify the saved checksum (`sha256sum -c "$archive.sha256"` or compare the PowerShell hash to the stored value). Confirm the destination URI and choose a fresh, empty database different from the source. Preview with `--dryRun --verbose`, then perform the restore. Check the intended namespaces in the output and require zero failed documents.

   ```sh
   mongorestore --config=restore.yml --gzip --archive="$archive" --nsInclude="$sourceDb.*" --nsFrom="$sourceDb.*" --nsTo="$restoredDb.*" --dryRun --verbose
   mongorestore --config=restore.yml --gzip --archive="$archive" --nsInclude="$sourceDb.*" --nsFrom="$sourceDb.*" --nsTo="$restoredDb.*" --stopOnError
   ```

   If restoration fails, investigate and retry into another empty database. Preserve collection options and indexes so the application can check validator and index definitions at startup. [MongoDB restore options](https://www.mongodb.com/docs/database-tools/mongorestore/)
4. In the restored database, clear `authSessions` and `authChallenges` before serving traffic. This makes clients sign in again and prevents a backup from reactivating old setup, recovery or login credentials. In an authenticated `mongosh` session connected to the **restore target**, verify `db.getName()`, then run `db.authSessions.deleteMany({})` and `db.authChallenges.deleteMany({})`. Review access and password changes made after the backup against the incident record before cutover. Revoke access, rotate affected passwords and reissue necessary invitations as appropriate.
5. Check restored validators and indexes with the release's migration command, and verify replica-set readiness. Start the API against the restored database while access is restricted. Compare representative records with the backup inventory, including session state, booking serials, completed outcomes and audit history. Sign in afresh and verify the appropriate staff and patient views. Record the archive, result and elapsed recovery time before switching the demo to the restored target. During a drill leave the original service on its original database and remove the drill copy and temporary access when you finish.

## Browser smoke suite

Build the apps with the API origin set to `http://127.0.0.1:4000` or left unset, and leave loopback ports 3000 and 4000 free. Start a writable local MongoDB replica set independently. Install the browser with `pnpm exec playwright install chromium` (use `--with-deps` on a CI runner). Set `SMOKE_MONGODB_URI` explicitly and run `pnpm test:smoke`. Set `SMOKE_BROWSER_CHANNEL=msedge` to use an installed Edge browser. [Playwright test web servers](https://playwright.dev/docs/test-webserver)

For Compose, use `mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true`. For authenticated Scoop, connect with `mongosh` as the local user administrator and provision a test user in a fresh database.

```javascript
db.getSiblingDB('practice_smoke_demo').createUser({
  user: 'smoke_runner', pwd: passwordPrompt(), roles: ['readWrite']
})
```

Set `SMOKE_MONGODB_DB=practice_smoke_demo` and use that database as the URI's `authSource`. For an unauthenticated local replica set, omit `SMOKE_MONGODB_DB` to generate a fresh database name for each run. Explicit names must start with `practice_smoke_`. The suite reserves an empty database, applies migrations and seeds a synthetic administrator. It keeps the database for diagnostics or a backup drill. Remove the generated databases and test credentials after use. Keep them separate from ordinary development data.

Desktop and emulated mobile projects open independent browser contexts for the administrator, doctor and patient and use the built application. They assert the booking and completion outcomes, deliberately interrupt the patient's event stream, and check polling and reconnection before closing the session.

## JWT login sessions

Login sessions use signed JWT cookies. Supply a stable, independently generated `JWT_SESSION_SECRET` of at least 32 bytes to every API instance. Keep it outside source control and task caches. Rotating the secret invalidates all JWT sessions. Upgrading from the previous opaque-token release requires users to sign in again. The database still stores only token hashes and enforces revocation and credential versions, and the backup restore procedure still clears sessions and challenges. An unset development key is process-local and expires all existing login sessions when the API restarts.

## OpenAPI

The versioned [OpenAPI document](openapi.json) covers the REST and event stream routes. Run `pnpm openapi:generate` after changing a route or public contract. Update the operation catalog in `backend/src/scripts/generate-openapi.ts` when the API's methods, paths, response statuses or access rules change. `pnpm check` checks the catalog against the route declarations and verifies that the saved document matches generation.
