# Live Bot Map

A dark, animated map of every Grok Bot [Dan Bennett](https://danbennett.me) runs. Bots appear as glowing nodes grouped by role. Nodes pulse if they were active in the last 10 minutes, glow if they were active in the last 24 hours, and dim otherwise. There is a live activity ticker, search, cluster filters, and a card list view.

Live site: https://live-bot-map-sand.vercel.app


## How the feed works

The site is static. Every 60 seconds the page fetches a public `status.json` from a Vercel Blob store (the URL is in `config.js`) and animates any changes.

A refresher on Dan's machine builds that feed. It reads each bot's name, a short role, and avatar colour from local profiles, and only message timestamps plus sender type from a local activity index — never message text. Each bot is keyed by a stable name slug (for example `mew`), with fixed map positions from `clusters.json`. The payload also includes last-active time, a 24-hour event count, and a generic status such as Working, Replying, Idle, or Running a routine.

The loop runs every 90 seconds. Unchanged payloads are skipped, but a publish is forced at least every 10 minutes so the LIVE badge stays honest.

Optional role overrides live next to each bot in `clusters.json`.

## Privacy

The public feed and this site do not include message content, prompts, command arguments, emails, secrets, or internal bot ids. Roles are short and edited so they don't name employers, private hosts, or other internal systems. The pages are served with a noindex robots policy.

## Restart the refresher

```bash
mkdir -p /workspace/live-bot-map/logs
setsid nohup env PYTHONUNBUFFERED=1 python3 /workspace/live-bot-map/scripts/refresh.py --loop >> /workspace/live-bot-map/logs/refresher.log 2>&1 < /dev/null &
echo $! > /workspace/live-bot-map/logs/refresher.pid
```

Or run `/workspace/live-bot-map/scripts/start-refresher.sh`.

The write token for the blob store is read from the `BLOB_READ_WRITE_TOKEN` environment variable, or from a local `.secrets/blob-token` file that is not in this repository.

A one-off publish:

```bash
python3 /workspace/live-bot-map/scripts/refresh.py --force
```
