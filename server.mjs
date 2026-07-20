import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, normalize, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  LeaderboardError,
  LeaderboardStore,
  LEADERBOARD_MAPS,
} from './src/server/leaderboard.mjs';
import { normalizeCharacterId } from './src/player/profile.js';
import {
  acceptAuthoritySnapshot,
  applyAuthoritativeDamageResult,
  authorityLeaseExpired,
  authoritySnapshotEnvelope,
  isWaitingForRound,
  MAX_ROOM_PLAYERS,
  nextJoinRound,
  normalizeRoomAuthority,
  playerStateMatchesRoomRound,
  publicRoomSummary,
  releasePlayersForRound,
  resetPlayerForRound,
  roomPhase,
  sanitizePlayerState,
  snapshotRound,
  transferRoomAuthority,
} from './src/shared/rooms-core.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8020;
const MAX_PLAYERS = MAX_ROOM_PLAYERS;
const HEARTBEAT_INTERVAL_MS = 25_000;
const RECONNECT_GRACE_MS = Math.max(
  5_000,
  Math.min(120_000, Number(process.env.TINY_STRIKE_RECONNECT_GRACE_MS) || 45_000)
);
const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://guyzyskind.com',
  'https://www.guyzyskind.com',
]);
const rooms = new Map();

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function parseAllowedOrigins(value = process.env.TINY_STRIKE_ALLOWED_ORIGINS) {
  const configured = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const entries = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  const origins = new Set();
  for (const entry of entries) {
    const origin = normalizeOrigin(entry);
    if (!origin || entry === '*') {
      throw new TypeError(`Invalid exact origin in TINY_STRIKE_ALLOWED_ORIGINS: ${entry}`);
    }
    origins.add(origin);
  }
  return origins;
}

function resolveLeaderboardFilePath(env = process.env, root = ROOT) {
  const explicitFile = String(env.TINY_STRIKE_LEADERBOARD_PATH || '').trim();
  if (explicitFile) return resolve(root, explicitFile);
  const dataDirectory = String(env.TINY_STRIKE_DATA_DIR || '').trim();
  return resolve(dataDirectory ? resolve(root, dataDirectory) : resolve(root, '.tiny-strike'), 'leaderboard.json');
}

const allowedOrigins = parseAllowedOrigins();
let leaderboard = new LeaderboardStore({
  filePath: resolveLeaderboardFilePath(),
  season: process.env.TINY_STRIKE_SEASON || 'season-1',
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function cleanName(value) {
  const name = String(value || '').trim().replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 20);
  return name || 'Operative';
}

function cleanRoomCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function cleanMapId(value) {
  const mapId = String(value || '').toLowerCase();
  return LEADERBOARD_MAPS.includes(mapId) ? mapId : 'dustyard';
}

function cleanCharacterId(value) {
  return normalizeCharacterId(value);
}

function makeRoomCode() {
  let code;
  do code = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
  return code;
}

function publicPlayer(player, hostId) {
  const spectating = isWaitingForRound(player);
  const eligibleRound = spectating ? Number(player.joinRound) : null;
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    host: player.id === hostId,
    alive: player.alive,
    characterId: cleanCharacterId(player.characterId),
    spectating,
    joinRound: eligibleRound,
    waitingForRound: spectating,
    eligibleRound,
  };
}

function roomPayload(room) {
  const authority = authoritySnapshotEnvelope(room, null);
  return {
    type: 'lobby',
    room: room.code,
    mode: room.mode,
    mapId: room.mapId,
    started: room.started,
    hostId: room.hostId,
    authorityEpoch: authority.authorityEpoch,
    snapshotSeq: authority.snapshotSeq,
    serverTime: authority.serverTime,
    players: [...room.players.values()].map((p) => publicPlayer(p, room.hostId)),
  };
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload, exceptId = null) {
  const encoded = JSON.stringify(payload);
  for (const player of room.players.values()) {
    if (player.id !== exceptId && player.ws.readyState === WebSocket.OPEN) player.ws.send(encoded);
  }
}

function broadcastLobby(room) {
  broadcast(room, roomPayload(room));
}

function isConnectedAuthorityCandidate(player) {
  return !!player && player.connected !== false && player.ws?.readyState === WebSocket.OPEN;
}

function authorityCandidate(room, preferredId = null) {
  const preferred = preferredId ? room.players.get(preferredId) : null;
  if (preferred && preferred.id !== room.hostId && Number(preferred.authorityProtocol) >= 1 &&
    isConnectedAuthorityCandidate(preferred)) return preferred;
  return [...room.players.values()]
    .filter((player) => player.id !== room.hostId && Number(player.authorityProtocol) >= 1 &&
      isConnectedAuthorityCandidate(player))
    .sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0))[0] || null;
}

function authorityEpochMatches(room, message, player) {
  const epoch = Number(message?.authorityEpoch);
  const exact = Number.isInteger(epoch) && epoch >= 0 && epoch === Number(room?.authorityEpoch);
  if (Number(player?.authorityProtocol) >= 1) return exact;
  return message?.authorityEpoch === undefined || message?.authorityEpoch === null ? true : exact;
}

function moveRoomAuthority(room, preferredId = null, reason = 'handoff') {
  const candidate = authorityCandidate(room, preferredId);
  if (!candidate) return null;
  const change = transferRoomAuthority(room, candidate.id, Date.now(), reason);
  if (!change) return null;
  broadcast(room, change);
  broadcastLobby(room);
  return change;
}

function recoverStalledAuthority(room, activePlayer) {
  if (!room.started || !activePlayer || activePlayer.id === room.hostId) return null;
  if (!authorityLeaseExpired(room, Date.now())) return null;
  return moveRoomAuthority(room, activePlayer.id, 'stalled');
}

function recordRankedKill(room, data) {
  if (!data || !room.matchStats) return;
  const killerId = typeof data.killerId === 'string' ? data.killerId : null;
  const victimId = typeof data.victimId === 'string' ? data.victimId : null;
  const killer = killerId ? room.players.get(killerId) : null;
  const victim = victimId ? room.players.get(victimId) : null;
  if (victim) {
    const victimStats = room.matchStats.get(victim.id);
    if (victimStats) victimStats.deaths++;
  }
  if (!killer || (data.victimTeam && data.victimTeam === killer.team)) return;
  const killerStats = room.matchStats.get(killer.id);
  if (!killerStats) return;
  killerStats.kills++;
  killerStats.headshots += data.headshot ? 1 : 0;
  if (victim) killerStats.killsHumans++;
  else killerStats.killsBots++;
}

function enrollMatchPlayer(room, player) {
  room.matchStats ||= new Map();
  if (!room.matchStats.has(player.id)) {
    room.matchStats.set(player.id, {
      kills: 0,
      deaths: 0,
      headshots: 0,
      killsHumans: 0,
      killsBots: 0,
      plants: 0,
      defuses: 0,
    });
  }
  room.matchPlayers ||= [];
  if (!room.matchPlayers.some((entry) => entry.id === player.id)) {
    room.matchPlayers.push({
      id: player.id,
      name: player.name,
      team: player.team,
      leaderboardPlayerId: player.leaderboardPlayerId,
    });
  }
}

function observeRankedSnapshot(room, state) {
  if (!state || !room.matchStats) return;
  const bomb = state.bomb || {};
  const planted = !!bomb.planted;
  if (planted && !room.lastObservedPlant) {
    const planter = typeof bomb.carrierId === 'string' ? room.players.get(bomb.carrierId) : null;
    if (planter && planter.team === 't') {
      const stats = room.matchStats.get(planter.id);
      if (stats) stats.plants++;
    }
  }
  room.lastObservedPlant = planted;

  const result = state.roundResult || {};
  if (result.reason === 'defuse' && typeof result.defuserId === 'string') {
    const key = `${Math.floor(Number(state.round) || 0)}:${result.defuserId}`;
    if (!room.observedDefuses.has(key)) {
      const defuser = room.players.get(result.defuserId);
      if (defuser && defuser.team === 'ct') {
        const stats = room.matchStats.get(defuser.id);
        if (stats) stats.defuses++;
      }
      room.observedDefuses.add(key);
    }
  }
}

function finalizeRankedRoom(room, state) {
  if (room.rankedFinalized) return;
  room.rankedFinalized = true;
  const scores = state && state.scores;
  if (!scores || !Number.isFinite(Number(scores.ct)) || !Number.isFinite(Number(scores.t))) return;
  const ct = Math.max(0, Math.floor(Number(scores.ct)));
  const t = Math.max(0, Math.floor(Number(scores.t)));
  const winner = state.matchWinner === 'ct' || state.matchWinner === 't'
    ? state.matchWinner
    : ct === t ? 'draw' : ct > t ? 'ct' : 't';
  const completedAt = new Date().toISOString();
  const participants = room.matchPlayers || [];
  for (const participant of participants) {
    if (!participant.leaderboardPlayerId) continue;
    const stats = room.matchStats && room.matchStats.get(participant.id);
    if (!stats) continue;
    const humanOpponents = participants.filter((other) => other.team !== participant.team).length;
    const botOpponents = room.mode === 'mixed' ? Math.max(0, 5 - humanOpponents) : 0;
    try {
      leaderboard.submitMatchForPlayer(participant.leaderboardPlayerId, {
        matchId: room.matchId,
        playerName: participant.name,
        mapId: room.mapId,
        mode: room.mode,
        winner,
        teamWon: winner === 'draw' ? false : participant.team === winner,
        scores: { ct, t },
        kills: stats.kills,
        deaths: stats.deaths,
        headshots: stats.headshots,
        plants: stats.plants,
        defuses: stats.defuses,
        killsHumans: stats.killsHumans,
        killsBots: stats.killsBots,
        humanOpponents,
        botOpponents,
        duration: Math.max(0, (Date.now() - room.startedAt) / 1000),
        roundsPlayed: ct + t,
        completedAt,
      });
    } catch (error) {
      console.warn(`[leaderboard] Could not rank ${participant.name}: ${error.message}`);
    }
  }
}

function chooseTeam(room) {
  let ct = 0;
  let t = 0;
  for (const p of room.players.values()) p.team === 't' ? t++ : ct++;
  return ct <= t ? 'ct' : 't';
}

function leaveRoom(player) {
  const room = player.roomCode ? rooms.get(player.roomCode) : null;
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = null;
  player.connected = false;
  if (!room || !room.players.delete(player.id)) return;

  broadcast(room, { type: 'player_left', id: player.id, name: player.name });
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id && !moveRoomAuthority(room, null, 'left')) room.hostId = null;
  broadcastLobby(room);
}

function detachFromRoom(player, ws) {
  if (player.ws !== ws || !player.roomCode) return;
  player.connected = false;
  if (rooms.get(player.roomCode)?.hostId === player.id) {
    moveRoomAuthority(rooms.get(player.roomCode), null, 'disconnected');
  }
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(() => leaveRoom(player), RECONNECT_GRACE_MS);
  player.disconnectTimer.unref?.();
}

function welcomePayload(room, client, resumed = false) {
  const spectating = isWaitingForRound(client);
  const eligibleRound = spectating ? Number(client.joinRound) : null;
  return {
    type: 'welcome',
    id: client.id,
    room: room.code,
    mode: room.mode,
    mapId: room.mapId,
    ranked: !!client.leaderboardPlayerId,
    reconnectToken: client.reconnectToken,
    resumed,
    lateJoin: !resumed && spectating,
    spectating,
    joinRound: eligibleRound,
    waitingForRound: spectating,
    eligibleRound,
    ...authoritySnapshotEnvelope(room, null),
    hostId: room.hostId,
  };
}

function reconnectToRoom(ws, msg) {
  const code = cleanRoomCode(msg.room);
  const token = String(msg.reconnectToken || '');
  const room = code ? rooms.get(code) : null;
  if (!room || !token) {
    send(ws, { type: 'error', message: 'That room session can no longer be resumed.' });
    return null;
  }
  const client = [...room.players.values()].find((player) =>
    !player.connected && player.reconnectToken === token
  );
  if (!client) {
    send(ws, { type: 'error', message: 'That room session can no longer be resumed.' });
    return null;
  }

  if (client.disconnectTimer) clearTimeout(client.disconnectTimer);
  client.disconnectTimer = null;
  client.ws = ws;
  client.connected = true;
  client.lastActivityAt = Date.now();
  client.authorityProtocol = Math.max(0, Math.floor(Number(msg.authorityProtocol) || 0));
  let recoveredAuthority = null;
  const currentHost = room.hostId ? room.players.get(room.hostId) : null;
  if (!isConnectedAuthorityCandidate(currentHost) && Number(client.authorityProtocol) >= 1) {
    recoveredAuthority = transferRoomAuthority(room, client.id, Date.now(), 'reconnected');
  }
  send(ws, welcomePayload(room, client, true));
  if (recoveredAuthority) broadcast(room, recoveredAuthority);

  if (room.started) {
    const spectating = isWaitingForRound(client);
    send(ws, {
      type: 'match_resume',
      room: room.code,
      matchId: room.matchId,
      mapId: room.mapId,
      mode: room.mode,
      players: [...room.players.values()].map((player) => publicPlayer(player, room.hostId)),
      lateJoin: false,
      spectating,
      joinRound: spectating ? Number(client.joinRound) : null,
      waitingForRound: spectating,
      eligibleRound: spectating ? Number(client.joinRound) : null,
      ...authoritySnapshotEnvelope(room),
      hostId: room.hostId,
    });
  } else {
    broadcastLobby(room);
  }
  return client;
}

function joinRoom(ws, client, msg) {
  if (msg.action === 'reconnect') return reconnectToRoom(ws, msg);
  if (client.roomCode) return send(ws, { type: 'error', message: 'Already in a room.' });
  const action = msg.action === 'create' ? 'create' : 'join';
  let code = cleanRoomCode(msg.room);
  let room = code ? rooms.get(code) : null;

  if (action === 'create') {
    if (room) return send(ws, { type: 'error', message: 'That room code is already in use.' });
    code = code || makeRoomCode();
    room = {
      code,
      mode: msg.mode === 'humans' ? 'humans' : 'mixed',
      mapId: cleanMapId(msg.mapId),
      hostId: client.id,
      players: new Map(),
      started: false,
      lastSnapshot: null,
      authorityEpoch: 1,
      snapshotSeq: 0,
      authorityAssignedAt: Date.now(),
      discoverable: msg.discoverable !== false,
    };
    rooms.set(code, room);
  } else {
    if (!room) return send(ws, { type: 'error', message: 'Room not found.' });
    if (room.started && roomPhase(room) === 'gameEnd') {
      return send(ws, { type: 'error', message: 'That match has ended.' });
    }
    if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'That room is full.' });
  }

  const lateJoin = room.started;
  const rankedPlayer = leaderboard.authenticate(msg.leaderboardToken);
  if (rankedPlayer && [...room.players.values()].some((player) =>
    player.leaderboardPlayerId === rankedPlayer.id
  )) {
    return send(ws, {
      type: 'error',
      code: 'ranked_identity_in_use',
      message: 'That ranked identity is already playing in this room. Reconnect the existing player instead.',
    });
  }
  client.leaderboardPlayerId = rankedPlayer ? rankedPlayer.id : null;
  client.name = rankedPlayer ? rankedPlayer.name : cleanName(msg.name);
  client.characterId = cleanCharacterId(msg.characterId);
  client.roomCode = room.code;
  client.team = chooseTeam(room);
  client.joinRound = lateJoin ? nextJoinRound(room) : null;
  client.alive = !lateJoin;
  client.connected = true;
  client.lastActivityAt = Date.now();
  client.authorityProtocol = Math.max(0, Math.floor(Number(msg.authorityProtocol) || 0));
  room.players.set(client.id, client);

  let recoveredAuthority = null;
  const currentHost = room.hostId ? room.players.get(room.hostId) : null;
  if (!isConnectedAuthorityCandidate(currentHost) && Number(client.authorityProtocol) >= 1) {
    recoveredAuthority = transferRoomAuthority(room, client.id, Date.now(), 'reconnected');
  }

  send(ws, welcomePayload(room, client));
  if (recoveredAuthority) broadcast(room, recoveredAuthority);
  broadcastLobby(room);
  if (lateJoin) {
    send(ws, {
      type: 'match_resume',
      room: room.code,
      matchId: room.matchId,
      mapId: room.mapId,
      mode: room.mode,
      players: [...room.players.values()].map((player) => publicPlayer(player, room.hostId)),
      lateJoin: true,
      spectating: true,
      joinRound: Number(client.joinRound),
      waitingForRound: true,
      eligibleRound: Number(client.joinRound),
      ...authoritySnapshotEnvelope(room),
      hostId: room.hostId,
    });
  }
  return client;
}

function startMatch(room, client) {
  if (room.hostId !== client.id) return send(client.ws, { type: 'error', message: 'Only the host can start.' });
  if (room.started) return;
  if (room.mode === 'humans' && room.players.size < 2) {
    return send(client.ws, { type: 'error', message: 'Humans-only needs at least two players.' });
  }

  const counts = { ct: 0, t: 0 };
  for (const p of room.players.values()) counts[p.team]++;
  if (room.mode === 'humans' && (counts.ct === 0 || counts.t === 0)) {
    return send(client.ws, { type: 'error', message: 'Put at least one player on each team.' });
  }

  const now = Date.now();
  normalizeRoomAuthority(room, now);
  room.started = true;
  room.currentRound = 1;
  room.matchId = randomUUID();
  room.startedAt = now;
  room.lastSnapshot = null;
  room.lastAuthoritySnapshotAt = null;
  room.authorityAssignedAt = now;
  room.authorityEpoch += 1;
  room.snapshotSeq = 0;
  room.rankedFinalized = false;
  room.matchStats = new Map(
    [...room.players.values()].map((player) => [player.id, {
      kills: 0,
      deaths: 0,
      headshots: 0,
      killsHumans: 0,
      killsBots: 0,
      plants: 0,
      defuses: 0,
    }])
  );
  room.matchPlayers = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    team: player.team,
    leaderboardPlayerId: player.leaderboardPlayerId,
  }));
  room.lastObservedPlant = false;
  room.observedDefuses = new Set();
  for (const p of room.players.values()) p.alive = true;
  broadcast(room, {
    type: 'match_start',
    room: room.code,
    matchId: room.matchId,
    mapId: room.mapId,
    mode: room.mode,
    ...authoritySnapshotEnvelope(room, null),
    hostId: room.hostId,
    players: [...room.players.values()].map((p) => publicPlayer(p, room.hostId)),
  });
}

function handleRoomMessage(client, msg) {
  const room = client.roomCode ? rooms.get(client.roomCode) : null;
  if (!room) return send(client.ws, { type: 'error', message: 'Join a room first.' });

  switch (msg.type) {
    case 'set_team': {
      if (room.started && !isWaitingForRound(client)) return;
      const team = msg.team === 't' ? 't' : 'ct';
      let count = 0;
      for (const p of room.players.values()) if (p.team === team && p.id !== client.id) count++;
      if (count >= 5) return send(client.ws, { type: 'error', message: 'That team is full.' });
      client.team = team;
      const participant = room.matchPlayers?.find((entry) => entry.id === client.id);
      if (participant) participant.team = team;
      broadcastLobby(room);
      break;
    }
    case 'set_profile':
      if (!room.started) {
        client.name = cleanName(msg.name);
        client.characterId = cleanCharacterId(msg.characterId);
        broadcastLobby(room);
      }
      break;
    case 'set_mode':
      if (!room.started && room.hostId === client.id) {
        room.mode = msg.mode === 'humans' ? 'humans' : 'mixed';
        broadcastLobby(room);
      }
      break;
    case 'set_map':
      if (!room.started && room.hostId === client.id) {
        room.mapId = cleanMapId(msg.mapId);
        broadcastLobby(room);
      }
      break;
    case 'start_match':
      startMatch(room, client);
      break;
    case 'player_state': {
      if (!room.started || !msg.state) return;
      client.lastActivityAt = Date.now();
      const state = sanitizePlayerState(msg.state);
      if (!state || !playerStateMatchesRoomRound(room, state, client.authorityProtocol)) return;
      recoverStalledAuthority(room, client);
      if (isWaitingForRound(client)) return;
      state.characterId = cleanCharacterId(state.characterId || client.characterId);
      if (client.alive === false) {
        state.alive = false;
        state.health = 0;
      }
      else if (typeof state.alive === 'boolean') client.alive = state.alive;
      client.characterId = state.characterId;
      client.state = state;
      broadcast(room, { type: 'player_state', id: client.id, state }, client.id);
      break;
    }
    case 'snapshot':
      if (room.started && room.hostId === client.id && msg.snapshot && authorityEpochMatches(room, msg, client)) {
        const incomingRound = Number(msg.snapshot?.state?.round);
        const trackedRound = snapshotRound(room);
        if (trackedRound !== null && Number.isFinite(incomingRound) && incomingRound < trackedRound) return;
        const previousRound = snapshotRound(room);
        let envelope = acceptAuthoritySnapshot(room, msg.snapshot, Date.now());
        if (!envelope) return;
        const acceptedSnapshot = envelope.snapshot;
        const snapshotRoundValue = Number(acceptedSnapshot?.state?.round);
        if (Number.isFinite(snapshotRoundValue) && snapshotRoundValue >= 0) {
          room.currentRound = Math.floor(snapshotRoundValue);
        }
        if (acceptedSnapshot.state) observeRankedSnapshot(room, acceptedSnapshot.state);
        const currentRound = snapshotRound(room);
        let resetCanonicalPlayers = false;
        if (currentRound !== null && (previousRound === null || currentRound > previousRound)) {
          for (const player of room.players.values()) {
            if (!isWaitingForRound(player)) resetPlayerForRound(player);
          }
          resetCanonicalPlayers = true;
        }
        const released = releasePlayersForRound(room, acceptedSnapshot.state);
        if (resetCanonicalPlayers || released.length) {
          envelope = authoritySnapshotEnvelope(room);
          room.lastSnapshot = envelope.snapshot;
        }
        broadcast(room, { type: 'snapshot', ...envelope }, client.id);
        for (const player of released) {
          enrollMatchPlayer(room, player);
          broadcast(room, {
            type: 'player_ready',
            id: player.id,
            round: Math.floor(Number(acceptedSnapshot.state.round)),
          });
        }
        if (released.length) broadcastLobby(room);
        if (acceptedSnapshot.state && acceptedSnapshot.state.phase === 'gameEnd') {
          finalizeRankedRoom(room, acceptedSnapshot.state);
        }
      }
      break;
    case 'yield_authority':
      if (room.started && room.hostId === client.id && authorityEpochMatches(room, msg, client)) {
        if (!moveRoomAuthority(room, null, 'yielded')) {
          send(client.ws, { type: 'authority_retained', ...authoritySnapshotEnvelope(room) });
        }
      }
      break;
    case 'fire':
    case 'grenade': {
      if (!room.started || client.id === room.hostId || client.alive === false || isWaitingForRound(client)) return;
      const host = room.players.get(room.hostId);
      if (host) send(host.ws, { ...msg, shooterId: client.id });
      break;
    }
    case 'damage':
      if (room.started && client.id === room.hostId && authorityEpochMatches(room, msg, client) &&
        msg.targetId && msg.result) {
        const target = room.players.get(msg.targetId);
        if (target && isWaitingForRound(target)) return;
        if (target) applyAuthoritativeDamageResult(target, msg.result);
        broadcast(room, { type: 'damage', ...msg });
      }
      break;
    case 'event':
      if (room.started && client.id === room.hostId && authorityEpochMatches(room, msg, client) && msg.event) {
        if (msg.event === 'kill') recordRankedKill(room, msg.data);
        broadcast(room, { type: 'event', event: msg.event, data: msg.data }, client.id);
      }
      break;
    default:
      break;
  }
}

function firstHeaderValue(value) {
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
}

function requestServerOrigin(req) {
  // Host is a browser-forbidden request header; do not trust a caller-supplied
  // X-Forwarded-Host when deciding whether an Origin is same-origin.
  const host = firstHeaderValue(req.headers.host);
  if (!host) return '';
  const forwardedProtocol = firstHeaderValue(req.headers['x-forwarded-proto']).toLowerCase();
  const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
    ? forwardedProtocol
    : req.socket?.encrypted ? 'https' : 'http';
  return normalizeOrigin(`${protocol}://${host}`);
}

function isRequestOriginAllowed(req) {
  const supplied = firstHeaderValue(req.headers.origin);
  if (!supplied) return true; // Native clients and same-origin GETs may omit Origin.
  const origin = normalizeOrigin(supplied);
  if (!origin) return false;
  return allowedOrigins.has(origin) || origin === requestServerOrigin(req);
}

function apiCorsHeaders(req) {
  const supplied = firstHeaderValue(req.headers.origin);
  if (!supplied) return {};
  if (!isRequestOriginAllowed(req)) return null;
  return {
    'Access-Control-Allow-Origin': normalizeOrigin(supplied),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function readJson(req, maxBytes = 32 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return rejectBody(new LeaderboardError(413, 'Request body is too large.'));
      if (size === 0) return resolveBody({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolveBody(parsed);
      } catch {
        rejectBody(new LeaderboardError(400, 'Request body must be valid JSON.'));
      }
    });
    req.on('error', rejectBody);
  });
}

function discoverableRooms() {
  const result = [];
  for (const [code, room] of rooms) {
    if (!room || room.players.size === 0) {
      rooms.delete(code);
      continue;
    }
    if (room.discoverable === false) continue;
    const summary = publicRoomSummary(room, MAX_PLAYERS);
    if (summary.players > 0) result.push(summary);
  }
  result.sort((left, right) =>
    Number(right.joinable) - Number(left.joinable) ||
    Number(left.started) - Number(right.started) ||
    left.code.localeCompare(right.code)
  );
  return result;
}

async function handleRoomsApi(req, res, url) {
  if (url.pathname !== '/api/rooms') return false;
  const corsHeaders = apiCorsHeaders(req);
  if (corsHeaders === null) {
    sendJson(res, 403, { error: 'Origin is not allowed.' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed.' }, { ...corsHeaders, Allow: 'GET, OPTIONS' });
    return true;
  }
  sendJson(res, 200, { rooms: discoverableRooms() }, corsHeaders);
  return true;
}

async function handleLeaderboardApi(req, res, url) {
  if (!url.pathname.startsWith('/api/leaderboard')) return false;
  const corsHeaders = apiCorsHeaders(req);
  if (corsHeaders === null) {
    sendJson(res, 403, { error: 'Origin is not allowed.' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return true;
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      const category = String(url.searchParams.get('category') || 'overall').toLowerCase();
      const result = leaderboard.leaderboard(category, url.searchParams.get('limit') || 50);
      sendJson(res, 200, result, corsHeaders);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/leaderboard/rules') {
      sendJson(res, 200, { season: leaderboard.data.season, rules: leaderboard.rules() }, corsHeaders);
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/leaderboard/session') {
      const body = await readJson(req);
      const token = bearerToken(req) || body.token;
      const session = leaderboard.createSession({ playerName: body.playerName, token });
      sendJson(res, session.resumed ? 200 : 201, session, corsHeaders);
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/leaderboard/matches') {
      const body = await readJson(req);
      const token = bearerToken(req) || body.sessionToken;
      const submission = leaderboard.submitMatch(token, body);
      sendJson(res, submission.duplicate ? 200 : 201, {
        accepted: true,
        duplicate: submission.duplicate,
        result: submission.result,
        player: submission.standing || { id: submission.player.id, name: submission.player.name },
        entry: submission.standing || undefined,
      }, corsHeaders);
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed.' }, { ...corsHeaders, Allow: 'GET, POST, OPTIONS' });
  } catch (error) {
    const status = error instanceof LeaderboardError ? error.status : 500;
    if (status === 500) console.error('[leaderboard] API failure:', error);
    sendJson(res, status, {
      error: status === 500 ? 'Leaderboard service failed.' : error.message,
      ...(error.details ? { details: error.details } : {}),
    }, corsHeaders);
  }
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/health') {
    const payload = JSON.stringify({ ok: true, service: 'tiny-strike', leaderboard: 'ready' });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method !== 'HEAD') res.end(payload);
    else res.end();
    return;
  }
  if (await handleRoomsApi(req, res, url)) return;
  if (await handleLeaderboardApi(req, res, url)) return;
  const rawPath = url.pathname;
  const pathname = rawPath === '/' ? '/index.html' : decodeURIComponent(rawPath);
  const candidate = resolve(ROOT, '.' + normalize(pathname));
  if (!candidate.startsWith(ROOT) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(candidate).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': candidate.includes('/node_modules/') ? 'public, max-age=3600' : 'no-cache',
  });
  createReadStream(candidate).pipe(res);
});

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 64 * 1024,
  verifyClient(info, done) {
    if (isRequestOriginAllowed(info.req)) done(true);
    else done(false, 403, 'Origin is not allowed.');
  },
});
wss.on('connection', (ws) => {
  let client = {
    id: randomUUID().replace(/-/g, '').slice(0, 12),
    ws,
    name: 'Operative',
    characterId: 'vanguard',
    team: 'ct',
    roomCode: null,
    alive: true,
    connected: true,
    lastActivityAt: Date.now(),
    reconnectToken: randomBytes(24).toString('base64url'),
    authorityProtocol: 0,
    disconnectTimer: null,
  };

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') {
      const joined = joinRoom(ws, client, msg);
      if (joined) client = joined;
    }
    else if (client.ws === ws) handleRoomMessage(client, msg);
  });
  ws.on('close', () => detachFromRoom(client, ws));
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
heartbeat.unref();

function startServer(port = PORT) {
  return server.listen(port, () => {
    const address = server.address();
    const activePort = address && typeof address === 'object' ? address.port : port;
    console.log(`Tiny Strike server: http://localhost:${activePort}`);
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();

function setLeaderboardStore(store) {
  if (!store || typeof store.leaderboard !== 'function') throw new TypeError('A LeaderboardStore is required.');
  leaderboard = store;
}

export {
  parseAllowedOrigins,
  resolveLeaderboardFilePath,
  rooms,
  server,
  setLeaderboardStore,
  startServer,
};
