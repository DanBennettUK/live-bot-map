# Live Bot Map

A dark, animated map of every Grok Bot [Dan Bennett](https://danbennett.me) runs. Bots appear as glowing nodes grouped by role. Nodes pulse if they were active in the last 10 minutes, glow if they were active in the last 24 hours, and dim otherwise. There is a live activity ticker, search, cluster filters, and a card list view.

Live site: https://live-bot-map.dan-5bd.workers.dev

The old Vercel URL, https://live-bot-map-sand.vercel.app, now redirects to the Workers site.


## How the feed works

The site is static. Every 60 seconds the page fetches a public `status.json` from the Worker (`/status.json`, configured in `config.js`) and animates any changes. The feed is stored in Workers KV and served with a 15-second cache.

A refresher on Dan's machine builds that feed. It reads each bot's name, a short role, and avatar colour from local profiles, and only message timestamps plus sender type from a local activity index — never message text. Each bot is keyed by a stable name slug (for example `mew`), with fixed map positions from `clusters.json`. The payload also includes last-active time, a 24-hour event count, and a generic status such as Working, Replying, Idle, or Running a routine.

The loop runs every 120 seconds. Unchanged payloads are skipped, but a publish is forced at least every 10 minutes so the LIVE badge stays honest. A restart does not publish again unless the payload changed or those 10 minutes have elapsed. The work-fleet export is fetched at most every 5 minutes and cached between loops.

Optional role overrides live next to each bot in `clusters.json`.

## Privacy

The public feed and this site do not include message content, prompts, command arguments, emails, secrets, or internal bot ids. Roles are short and edited so they don't name employers, private hosts, or other internal systems. The pages are served with a noindex robots policy.

## Running the refresher

`scripts/start-refresher.sh` starts the loop. It sources a gitignored local env file if present (`.secrets/refresher.env`, or the path in `LBM_ENV_FILE`). The script itself also loads that file, so a one-off `python3 scripts/refresh.py --force` works from the repo root.

Paths and optional extra stripping are configured with environment variables, not hardcoded locations:

- `LBM_ROOT` — checkout directory (defaults to the repository root, next to `scripts/`)
- `LBM_AGENTS_DIR` — directory of bot profile folders
- `LBM_INDEX_DB` — SQLite activity index (timestamps and sender type only)
- `LBM_DELETED_AGENTS` — optional JSON list of deleted bot ids (defaults to `deleted-agents.json` beside `LBM_AGENTS_DIR`)
- `LBM_BANNED_TERMS` — optional comma-separated extra terms to strip from public role text
- `LBM_BANNED_TERMS_FILE` — optional blocklist file, one term per line (defaults to `.secrets/banned-terms.txt`)
- `LBM_CF_STATUS_URL` — Workers feed URL (`https://live-bot-map.dan-5bd.workers.dev/status.json`)
- `LBM_CF_PUBLISH_TOKEN` — secret for publishing to that Worker, or a gitignored `.secrets/cf-publish-token` file
- `LBM_WORK_EXPORT_HOST` — optional SSH host alias for a read-only work-fleet activity export
- `LBM_WORK_EXPORT_CMD` — optional remote command that prints JSON counts only

If no blocklist file or `LBM_BANNED_TERMS` is set, the refresher still strips emails, URLs and ids from public strings.

```bash
./scripts/start-refresher.sh
```

```bash
python3 scripts/refresh.py --force
```

## Deploying to Cloudflare Workers

The Worker serves the static files plus `/status.json`. Static assets are copied from the repository root into a gitignored `public/` folder at deploy time. After logging in with Wrangler:

```bash
./scripts/sync-worker-assets.sh && npx wrangler deploy
```

The publish token is a Wrangler secret named `PUBLISH_TOKEN` (`npx wrangler secret put PUBLISH_TOKEN`). It is not committed.

The old Vercel Blob store is unused; the refresher publishes only to the Worker. The Vercel project has not been deleted, and its URL redirects here.
