# Tiny Strike leaderboard API

The leaderboard is same-origin and JSON-only. The default single-process store
is `.tiny-strike/leaderboard.json`; set `TINY_STRIKE_LEADERBOARD_PATH` and
`TINY_STRIKE_SEASON` when deploying. Writes atomically replace the JSON file.
Session tokens are opaque bearer credentials and only their SHA-256 digests are
stored.

## Identity

`POST /api/leaderboard/session`

```json
{ "playerName": "Operative", "token": "optional previous token" }
```

The token may instead be sent as `Authorization: Bearer <token>`. A new session
returns HTTP 201; a valid resumed session returns 200:

```json
{
  "player": { "id": "player UUID", "name": "Operative" },
  "token": "ts_opaque-token",
  "resumed": false
}
```

Store the token locally and send it in the WebSocket `hello` message as
`leaderboardToken` so live rooms can record authoritative results.

## Submit a solo result

`POST /api/leaderboard/matches` with the bearer token:

```json
{
  "matchId": "client-generated UUID",
  "playerName": "display-only; identity comes from token",
  "mapId": "dustyard",
  "mode": "solo",
  "winner": "ct",
  "teamWon": true,
  "scores": { "ct": 8, "t": 5 },
  "kills": 16,
  "deaths": 8,
  "headshots": 6,
  "plants": 0,
  "defuses": 2,
  "durationSeconds": 820,
  "roundsPlayed": 13,
  "completedAt": "2026-07-20T12:00:00.000Z"
}
```

`mode` may be `solo` or `bots` for HTTP submissions. Human and mixed results
are rejected because the WebSocket room server derives them from observed kill
events and the final authoritative snapshot. `duration` is accepted as an
alias for `durationSeconds`, and `won` as an alias for `teamWon`.

The server validates match completion, round totals, duration, kill/death/headshot
relationships, objective counts, map, and result age. It calculates all points;
clients cannot submit a score. Retries of a `playerId + matchId` return the
original result with `duplicate: true` and do not add points again.

An accepted response contains match points, the transparent component
breakdown, and the player's updated cumulative standings:

```json
{
  "accepted": true,
  "duplicate": false,
  "result": {
    "matchId": "client-generated UUID",
    "points": { "humans": 0, "bots": 184, "overall": 184 },
    "breakdown": { "bots": {}, "overall": {} }
  },
  "player": {
    "id": "player UUID",
    "name": "Operative",
    "score": 918,
    "overallRank": 4,
    "scores": { "humans": 0, "bots": 918, "overall": 918 },
    "ranks": { "humans": null, "bots": 2, "overall": 4 }
  }
}
```

## Read rankings

`GET /api/leaderboard?category=humans|bots|overall&limit=50`

The response contains `season`, `generatedAt`, public `rules`, and ranked
`entries`. Ties sort by score, wins, kills, fewer deaths, name, then player ID.
Human points are uncapped. Bot points score at full value for five UTC-day
matches, 50% for matches 6–10, 25% thereafter, with a 1,200 point daily cap.
This makes continued bot play useful without letting repetitive bot farming
dominate the overall board. The same rules are also available from
`GET /api/leaderboard/rules`.

## Live-room map protocol

Room creation accepts `mapId`; the host may send `{ "type": "set_map",
"mapId": "harbor" }` before start. `lobby`, `welcome`, and `match_start`
include the selected map. Valid IDs are `dustyard`, `frostline`,
`neon_foundry`, `harbor`, and `citadel`.
