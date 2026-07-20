# Tiny Strike Cloudflare service

The production service runs as one Worker with two SQLite-backed Durable
Objects:

- `LeaderboardDurableObject` is the strongly consistent global ranking store.
- `RoomDurableObject` is a hibernating room hub that preserves the existing
  `/ws` protocol, including create, join, authoritative relays, and reconnects.

Only `https://guyzyskind.com` is allowed by the committed production CORS and
WebSocket Origin policy. Local requests without an Origin remain available to
CLI health checks and tests.

## Deploy

```sh
npm run build:worker
npx wrangler secret put ADMIN_TOKEN
npm run deploy:worker
```

Use a randomly generated admin token of at least 24 characters. It is a
Cloudflare secret and must never be placed in `wrangler.jsonc`, `.dev.vars`, a
shell script, or git.

After deployment, verify:

```sh
curl https://WORKER_HOST/health
```

Then configure the static build with the deployed origin:

```sh
npm run build:pages -- --service-url https://WORKER_HOST
```

That writes both the leaderboard endpoint and multiplayer WebSocket endpoint
to `dist/tinystrike/runtime-config.js`.

## One-time migration

Import the existing JSON before opening the production game or creating any
production sessions. The endpoint rejects a second import and also rejects an
import after the first production player exists.

```sh
TINY_STRIKE_WORKER_URL=https://WORKER_HOST \
TINY_STRIKE_ADMIN_TOKEN=YOUR_ADMIN_TOKEN \
npm run import:leaderboard
```

The importer defaults to `.tiny-strike/leaderboard.json`; an explicit file can
be supplied after `--`. Raw session tokens are not present in that file—the
existing SHA-256 session digests are migrated, so current browsers retain their
ranked identity.

After a successful import, the `ADMIN_TOKEN` secret may be deleted to remove
the public administrative capability entirely:

```sh
npx wrangler secret delete ADMIN_TOKEN
```

SQLite Durable Objects include point-in-time recovery, and the Worker exposes
no endpoint that clears or replaces a populated leaderboard.
