# Content Lab local service

Node 22 + Hono + `node:sqlite` service for the Mac-side collector and Codex worker. SQLite uses WAL. The HTTP process never invokes Codex; it only serves read APIs and enqueues the two allowed public writes (bind and analysis retry).

## Run locally

```bash
cd service
npm install
cp .env.example .env  # load it with your preferred process supervisor
npm run doctor
npm run dev           # web API, 127.0.0.1:4320
npm run worker        # scheduler, jobs, Codex, alerts and outbound sync
```

Useful one-shot commands are `npm run worker:once`, `npm test`, and `npm run build`. The service does not read `.env` itself; LaunchAgent or a shell wrapper should supply environment variables. Runtime data lives under `../var/` by default and is gitignored.

### Import existing source URLs

The public bind page supports Excel/CSV import. For a trusted local CSV manifest, preview the exact normalized URLs and provenance before enqueueing:

```bash
npx tsx src/import-csv.ts ../docs/source-imports/framelab-vn.csv --dry-run
npx tsx src/import-csv.ts ../docs/source-imports/framelab-vn.csv --enqueue
```

The local importer requires `url` and accepts `market`, `project_tag`, and `source` columns. It defaults to dry-run, validates the entire manifest, deduplicates tracking variants, and records the source filename/row/link in `bound_by`. It only queues URL collection: old metric or analysis columns are ignored. Current counts, capture timestamps, and provider provenance come from the real collector. Repeating the same manifest reuses its existing jobs. This trusted local command does not use the public rate-limit budget.

This Mac also uses the checked-in `launchd/` definitions for crash restart and login startup. The worker wrapper reads its pairing token from the `com.welly.content-lab.site-sync` generic-password item in the login Keychain; the secret is never stored in this repository.

To reinstall the checked-in agents on this Mac, first add or update the token interactively with `security add-generic-password -U -a welly -s com.welly.content-lab.site-sync -w`, then copy both plist files into `~/Library/LaunchAgents/` and bootstrap them with `launchctl bootstrap gui/$(id -u) <plist>`. Logs are written under ignored `var/log/`.

## Local API

- `GET /health`
- `GET /api/overview`
- `GET /api/posts?market=&projectTag=&creator=&tag=&state=&sort=&direction=`
- `GET /api/posts/:id`
- `POST /api/posts/bind` (also `POST /api/posts`) with `{urls, market?, projectTag?, boundBy?, bindSecret?, turnstileToken?}`
- `GET /api/jobs`
- `POST /api/jobs/:id/retry` (failed/dead `analyze` jobs only)

Bind accepts 1–50 HTTPS TikTok URLs, canonicalizes and deduplicates them, and budgets in URL units. Defaults: 30 URLs/IP/hour, 300 new URLs/rolling day, 1,000 active plus pending posts. Configure a bind secret and Turnstile for a directly exposed local endpoint. The hosted GPT Site should apply its own equivalent controls.

## GPT Site outbound sync contract

When both `SITE_SYNC_URL` and `SITE_SYNC_TOKEN` are set, only the worker makes outbound HTTPS requests. No route from the hosted site reaches Codex, SQLite, or another Mac service.

All requests use `Authorization: Bearer <SITE_SYNC_TOKEN>`, JSON, and an `Idempotency-Key` header:

- `POST /api/local-worker/jobs/lease` — request `{workerId, limit, leaseSeconds}`; response `{jobs:[{id,kind:"bind",payload:{urls,sitePostId?,market?,projectTag?,boundBy?},attempts}]}`. A job with `sitePostId` must contain exactly one URL; that ID is persisted and echoed on every related read-model event.
- `POST /api/local-worker/jobs/:id/complete` — `{workerId}`.
- `POST /api/local-worker/jobs/:id/fail` — `{workerId,error,retryable}`.
- `POST /api/local-worker/sync` — `{workerId,events:[{id,type,entityKey,occurredAt,payload}]}`; response `{accepted:[eventId...]}`. Supported event types are `post`, `snapshot`, `features`, `prediction`, `job`, and `alert`.

The local `sync_outbox` is idempotent by entity and retries with exponential backoff. The hosted side should upsert read-model entities by `entityKey`, deduplicate event IDs, lease each bind job to one worker, and make completion/failure idempotent.

## Collection and analysis behavior

TikWM is throttled to one request per 1.25 seconds with retry/backoff. TikTok oEmbed is a metadata-only fallback; it never fabricates metrics. Failed hours are stored as unavailable/missing, while a successful post-sleep capture assigns the cross-gap delta to the wake-up hour with `interpolated` coverage. Cadence is hourly through 72h, every three hours through day 7 (promoted to hourly at 5% three-hour growth), daily through day 30, then stopped.

Codex runs in a media-only directory with `--sandbox read-only --ephemeral --ignore-user-config --ignore-rules --output-schema`. The v3 taxonomy is a closed enum and is validated again before persistence. External captions and frame text are explicitly treated as untrusted data. Failed analyses retry twice after the initial attempt; terminal failures become `features_failed`, and authentication failures create an operations alert.
