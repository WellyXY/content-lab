# Content Lab GPT Site

Public, no-login signal desk for Content Lab. It keeps the dashboard, read model, and bind queue online while the collector and Codex analyzer stay on the owner's Mac.

## Local development

Requires Node 22.13+.

```bash
npm ci
npm run dev
```

The preview runs on `http://127.0.0.1:5173`. D1 state is stored under ignored `.wrangler/` files.

After changing `db/schema.ts`, generate a new append-only migration and rebuild:

```bash
npm run db:generate
npm run build
```

Never modify a migration that has already been published. Production migrations in `drizzle/` are applied by the GPT Sites release workflow.

## Runtime contract

- D1 binding: `DB`
- Required secret: `LOCAL_WORKER_TOKEN`
- Optional write gate: `BIND_PASSPHRASE`
- Public routes: `/`, `/posts`, `/posts/:id`, `/bind`
- Worker bridge: `/api/local-worker/*`, protected with bearer authentication

The browser never calls localhost. The Mac worker leases bind jobs and pushes structure-only events over outbound HTTPS. Event IDs are deduplicated and local post IDs are correlated to hosted placeholder IDs.

The public bind endpoint accepts only TikTok domains and enforces 30 URLs per IP/hour, 300 new posts/day, 1,000 active posts, and 50 URLs/request. CSV/XLSX parsing runs in the browser.
