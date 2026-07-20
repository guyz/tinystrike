import { LEADERBOARD_MAPS } from '../src/shared/leaderboard-core.mjs';
import {
  isWaitingForRound,
  MAX_ROOM_PLAYERS,
  nextJoinRound,
  publicRoomSummary,
  releasePlayersForRound,
  roomPhase,
  snapshotRound,
} from '../src/shared/rooms-core.mjs';

const MAX_PLAYERS = MAX_ROOM_PLAYERS;
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_RECONNECT_GRACE_MS = 45_000;
const CHARACTER_IDS = new Set(['vanguard', 'ranger', 'breacher', 'shadow']);

function cleanName(value) {
  const name = String(value || '').trim().replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 20);
  return name || 'Operative';
}

export function cleanRoomCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function cleanMapId(value) {
  const mapId = String(value || '').toLowerCase();
  return LEADERBOARD_MAPS.includes(mapId) ? mapId : 'dustyard';
}

function cleanCharacterId(value) {
  const id = String(value || '').trim().toLowerCase();
  return CHARACTER_IDS.has(id) ? id : 'vanguard';
}

function randomToken(byteLength = 24) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function newConnection() {
  return {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 12),
    name: 'Operative',
    characterId: 'vanguard',
    team: 'ct',
    roomCode: null,
    alive: true,
    connected: true,
    reconnectToken: randomToken(),
    leaderboardPlayerId: null,
    disconnectDeadline: null,
    connectionNonce: crypto.randomUUID(),
  };
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

export function roomPayload(room) {
  return {
    type: 'lobby',
    room: room.code,
    mode: room.mode,
    mapId: room.mapId,
    started: room.started,
    hostId: room.hostId,
    players: Object.values(room.players).map((player) => publicPlayer(player, room.hostId)),
  };
}

function chooseTeam(room) {
  let ct = 0;
  let t = 0;
  for (const player of Object.values(room.players)) player.team === 't' ? t++ : ct++;
  return ct <= t ? 'ct' : 't';
}

function welcomePayload(room, client, resumed = false) {
  const spectating = isWaitingForRound(client);
  const eligibleRound = spectating ? Number(client.joinRound) : null;
  return {
    type: 'welcome',
    id: client.id,
    room: room.code,
    hostId: room.hostId,
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
  };
}

function recordRankedKill(room, data) {
  if (!data || !room.matchStats) return;
  const killerId = typeof data.killerId === 'string' ? data.killerId : null;
  const victimId = typeof data.victimId === 'string' ? data.victimId : null;
  const killer = killerId ? room.players[killerId] : null;
  const victim = victimId ? room.players[victimId] : null;
  if (victim) {
    const victimStats = room.matchStats[victim.id];
    if (victimStats) victimStats.deaths++;
  }
  if (!killer || (data.victimTeam && data.victimTeam === killer.team)) return;
  const killerStats = room.matchStats[killer.id];
  if (!killerStats) return;
  killerStats.kills++;
  killerStats.headshots += data.headshot ? 1 : 0;
  if (victim) killerStats.killsHumans++;
  else killerStats.killsBots++;
}

function enrollMatchPlayer(room, player) {
  room.matchStats ||= {};
  room.matchStats[player.id] ||= {
    kills: 0,
    deaths: 0,
    headshots: 0,
    killsHumans: 0,
    killsBots: 0,
    plants: 0,
    defuses: 0,
  };
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
    const planter = typeof bomb.carrierId === 'string' ? room.players[bomb.carrierId] : null;
    if (planter && planter.team === 't') {
      const stats = room.matchStats[planter.id];
      if (stats) stats.plants++;
    }
  }
  room.lastObservedPlant = planted;

  const result = state.roundResult || {};
  if (result.reason === 'defuse' && typeof result.defuserId === 'string') {
    const key = `${Math.floor(Number(state.round) || 0)}:${result.defuserId}`;
    room.observedDefuses ||= [];
    if (!room.observedDefuses.includes(key)) {
      const defuser = room.players[result.defuserId];
      if (defuser && defuser.team === 'ct') {
        const stats = room.matchStats[defuser.id];
        if (stats) stats.defuses++;
      }
      room.observedDefuses.push(key);
    }
  }
}

export class RoomDurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.connections = new Map();
    for (const ws of ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.id) this.connections.set(attachment.id, ws);
    }
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          code TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    });
  }

  _graceMs() {
    return Math.max(
      5_000,
      Math.min(120_000, Number(this.env.RECONNECT_GRACE_MS) || DEFAULT_RECONNECT_GRACE_MS),
    );
  }

  _room(code) {
    const row = this.sql.exec('SELECT data FROM rooms WHERE code = ?', code).toArray()[0];
    if (!row) return null;
    try {
      const room = JSON.parse(row.data);
      room.players ||= {};
      return room;
    } catch {
      return null;
    }
  }

  _saveRoom(room) {
    this.sql.exec(
      'INSERT INTO rooms(code, data, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      room.code,
      JSON.stringify(room),
      Date.now(),
    );
  }

  _deleteRoom(code) {
    this.sql.exec('DELETE FROM rooms WHERE code = ?', code);
  }

  _socket(playerId) {
    return this.connections.get(playerId) || null;
  }

  _send(ws, payload) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(payload)); } catch { /* disconnected between check and send */ }
  }

  _broadcast(room, payload, exceptId = null) {
    const encoded = JSON.stringify(payload);
    for (const player of Object.values(room.players)) {
      if (!player.connected || player.id === exceptId) continue;
      const socket = this._socket(player.id);
      if (!socket || socket.readyState !== 1) continue;
      try { socket.send(encoded); } catch { /* close handler owns cleanup */ }
    }
  }

  _broadcastLobby(room) {
    this._broadcast(room, roomPayload(room));
  }

  async _rankedPlayer(token) {
    if (!token) return null;
    const response = await this.env.LEADERBOARD.getByName('global-v1').fetch(
      new Request('https://internal/internal/auth', {
        method: 'POST',
        headers: { Authorization: `Bearer ${String(token).slice(0, 256)}` },
      }),
    );
    if (!response.ok) return null;
    const body = await response.json();
    return body.player || null;
  }

  _makeRoomCode() {
    for (let attempt = 0; attempt < 32; attempt++) {
      const bytes = new Uint8Array(3);
      crypto.getRandomValues(bytes);
      const code = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
      if (!this._room(code)) return code;
    }
    throw new Error('Could not allocate a room code.');
  }

  _newRoom(code, connection, message) {
    return {
      code,
      mode: message.mode === 'humans' ? 'humans' : 'mixed',
      mapId: cleanMapId(message.mapId),
      hostId: connection.id,
      players: {},
      started: false,
      lastSnapshot: null,
      discoverable: message.discoverable !== false,
    };
  }

  _syncAttachment(ws, player) {
    const attachment = { ...player };
    ws.serializeAttachment(attachment);
    this.connections.set(player.id, ws);
    return attachment;
  }

  async _reconnect(ws, freshConnection, message) {
    const code = cleanRoomCode(message.room);
    const token = String(message.reconnectToken || '');
    const room = code ? this._room(code) : null;
    const player = room && token
      ? Object.values(room.players).find((candidate) => !candidate.connected && candidate.reconnectToken === token)
      : null;
    if (!room || !player || !Number.isFinite(player.disconnectDeadline) || player.disconnectDeadline <= Date.now()) {
      if (room && player) this._removePlayer(room, player);
      this._send(ws, { type: 'error', message: 'That room session can no longer be resumed.' });
      return freshConnection;
    }

    this.connections.delete(freshConnection.id);
    player.connected = true;
    player.disconnectDeadline = null;
    player.connectionNonce = crypto.randomUUID();
    const connection = this._syncAttachment(ws, player);
    this._saveRoom(room);
    this._send(ws, welcomePayload(room, player, true));
    if (room.started) {
      const spectating = isWaitingForRound(player);
      this._send(ws, {
        type: 'match_resume',
        room: room.code,
        matchId: room.matchId,
        mapId: room.mapId,
        mode: room.mode,
        hostId: room.hostId,
        players: Object.values(room.players).map((entry) => publicPlayer(entry, room.hostId)),
        snapshot: room.lastSnapshot || null,
        lateJoin: false,
        spectating,
        joinRound: spectating ? Number(player.joinRound) : null,
        waitingForRound: spectating,
        eligibleRound: spectating ? Number(player.joinRound) : null,
      });
    } else {
      this._broadcastLobby(room);
    }
    await this._scheduleDisconnectAlarm();
    return connection;
  }

  async _join(ws, connection, message) {
    if (message.action === 'reconnect') return this._reconnect(ws, connection, message);
    if (connection.roomCode) {
      this._send(ws, { type: 'error', message: 'Already in a room.' });
      return connection;
    }
    const action = message.action === 'create' ? 'create' : 'join';
    const rankedPlayer = await this._rankedPlayer(message.leaderboardToken);
    let code = cleanRoomCode(message.room);
    let room = code ? this._room(code) : null;

    if (action === 'create') {
      if (room) {
        this._send(ws, { type: 'error', message: 'That room code is already in use.' });
        return connection;
      }
      code ||= this._makeRoomCode();
      room = this._newRoom(code, connection, message);
    } else {
      if (!room) {
        this._send(ws, { type: 'error', message: 'Room not found.' });
        return connection;
      }
      if (room.started && roomPhase(room) === 'gameEnd') {
        this._send(ws, { type: 'error', message: 'That match has ended.' });
        return connection;
      }
      if (Object.keys(room.players).length >= MAX_PLAYERS) {
        this._send(ws, { type: 'error', message: 'That room is full.' });
        return connection;
      }
    }

    const lateJoin = room.started;
    if (rankedPlayer && Object.values(room.players).some((player) =>
      player.leaderboardPlayerId === rankedPlayer.id
    )) {
      this._send(ws, {
        type: 'error',
        message: 'That ranked identity is already playing in this room. Reconnect the existing player instead.',
      });
      return connection;
    }
    Object.assign(connection, {
      leaderboardPlayerId: rankedPlayer?.id || null,
      name: rankedPlayer?.name || cleanName(message.name),
      characterId: cleanCharacterId(message.characterId),
      roomCode: room.code,
      team: chooseTeam(room),
      alive: !lateJoin,
      joinRound: lateJoin ? nextJoinRound(room) : null,
      connected: true,
      disconnectDeadline: null,
    });
    room.players[connection.id] = { ...connection };
    this._syncAttachment(ws, connection);
    this._saveRoom(room);
    this._send(ws, welcomePayload(room, connection));
    this._broadcastLobby(room);
    if (lateJoin) {
      this._send(ws, {
        type: 'match_resume',
        room: room.code,
        matchId: room.matchId,
        mapId: room.mapId,
        mode: room.mode,
        hostId: room.hostId,
        players: Object.values(room.players).map((entry) => publicPlayer(entry, room.hostId)),
        snapshot: room.lastSnapshot || null,
        lateJoin: true,
        spectating: true,
        joinRound: Number(connection.joinRound),
        waitingForRound: true,
        eligibleRound: Number(connection.joinRound),
      });
    }
    return connection;
  }

  _startMatch(room, player) {
    const socket = this._socket(player.id);
    if (room.hostId !== player.id) {
      this._send(socket, { type: 'error', message: 'Only the host can start.' });
      return false;
    }
    if (room.started) return false;
    const players = Object.values(room.players);
    if (room.mode === 'humans' && players.length < 2) {
      this._send(socket, { type: 'error', message: 'Humans-only needs at least two players.' });
      return false;
    }
    const counts = { ct: 0, t: 0 };
    for (const entry of players) counts[entry.team]++;
    if (room.mode === 'humans' && (counts.ct === 0 || counts.t === 0)) {
      this._send(socket, { type: 'error', message: 'Put at least one player on each team.' });
      return false;
    }

    room.started = true;
    room.currentRound = 1;
    room.matchId = crypto.randomUUID();
    room.startedAt = Date.now();
    room.rankedFinalized = false;
    room.matchStats = Object.fromEntries(players.map((entry) => [entry.id, {
      kills: 0,
      deaths: 0,
      headshots: 0,
      killsHumans: 0,
      killsBots: 0,
      plants: 0,
      defuses: 0,
    }]));
    room.matchPlayers = players.map((entry) => ({
      id: entry.id,
      name: entry.name,
      team: entry.team,
      leaderboardPlayerId: entry.leaderboardPlayerId,
    }));
    room.lastObservedPlant = false;
    room.observedDefuses = [];
    for (const entry of players) entry.alive = true;
    this._broadcast(room, {
      type: 'match_start',
      room: room.code,
      matchId: room.matchId,
      mapId: room.mapId,
      mode: room.mode,
      hostId: room.hostId,
      players: players.map((entry) => publicPlayer(entry, room.hostId)),
    });
    return true;
  }

  async _finalizeRankedRoom(room, state) {
    const scores = state && state.scores;
    if (!scores || !Number.isFinite(Number(scores.ct)) || !Number.isFinite(Number(scores.t))) return;
    const ct = Math.max(0, Math.floor(Number(scores.ct)));
    const t = Math.max(0, Math.floor(Number(scores.t)));
    const winner = state.matchWinner === 'ct' || state.matchWinner === 't'
      ? state.matchWinner
      : ct === t ? 'draw' : ct > t ? 'ct' : 't';
    const completedAt = new Date().toISOString();
    const participants = room.matchPlayers || [];
    const leaderboard = this.env.LEADERBOARD.getByName('global-v1');
    for (const participant of participants) {
      if (!participant.leaderboardPlayerId) continue;
      const stats = room.matchStats?.[participant.id];
      if (!stats) continue;
      const humanOpponents = participants.filter((other) => other.team !== participant.team).length;
      const botOpponents = room.mode === 'mixed' ? Math.max(0, 5 - humanOpponents) : 0;
      const payload = {
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
      };
      try {
        const response = await leaderboard.fetch(new Request('https://internal/internal/matches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: participant.leaderboardPlayerId, payload }),
        }));
        if (!response.ok) console.warn(`Could not rank ${participant.name}: ${await response.text()}`);
      } catch (error) {
        console.warn(`Could not rank ${participant.name}: ${error.message}`);
      }
    }
  }

  async _handleRoomMessage(ws, connection, message) {
    const room = connection.roomCode ? this._room(connection.roomCode) : null;
    if (!room || !room.players[connection.id]) {
      this._send(ws, { type: 'error', message: 'Join a room first.' });
      return connection;
    }
    const player = room.players[connection.id];
    let dirty = false;
    let finalizeState = null;

    switch (message.type) {
      case 'set_team': {
        if (room.started && !isWaitingForRound(player)) break;
        const team = message.team === 't' ? 't' : 'ct';
        const count = Object.values(room.players).filter((entry) => entry.team === team && entry.id !== player.id).length;
        if (count >= 5) this._send(ws, { type: 'error', message: 'That team is full.' });
        else {
          player.team = team;
          const participant = room.matchPlayers?.find((entry) => entry.id === player.id);
          if (participant) participant.team = team;
          dirty = true;
          this._broadcastLobby(room);
        }
        break;
      }
      case 'set_profile':
        if (!room.started) {
          player.name = cleanName(message.name);
          player.characterId = cleanCharacterId(message.characterId);
          dirty = true;
          this._broadcastLobby(room);
        }
        break;
      case 'set_mode':
        if (!room.started && room.hostId === player.id) {
          room.mode = message.mode === 'humans' ? 'humans' : 'mixed';
          dirty = true;
          this._broadcastLobby(room);
        }
        break;
      case 'set_map':
        if (!room.started && room.hostId === player.id) {
          room.mapId = cleanMapId(message.mapId);
          dirty = true;
          this._broadcastLobby(room);
        }
        break;
      case 'start_match':
        dirty = this._startMatch(room, player) || dirty;
        break;
      case 'player_state':
        if (room.started && message.state && !isWaitingForRound(player)) {
          const state = {
            ...message.state,
            characterId: cleanCharacterId(message.state.characterId || player.characterId),
          };
          if (player.alive === false) state.alive = false;
          else if (typeof message.state.alive === 'boolean') player.alive = message.state.alive;
          player.characterId = state.characterId;
          dirty = true;
          this._broadcast(room, { type: 'player_state', id: player.id, state }, player.id);
        }
        break;
      case 'snapshot':
        if (room.started && room.hostId === player.id && message.snapshot) {
          const previousRound = snapshotRound(room);
          room.lastSnapshot = message.snapshot;
          const snapshotRoundValue = Number(message.snapshot?.state?.round);
          if (Number.isFinite(snapshotRoundValue) && snapshotRoundValue >= 0) {
            room.currentRound = Math.floor(snapshotRoundValue);
          }
          if (message.snapshot.state) observeRankedSnapshot(room, message.snapshot.state);
          const currentRound = snapshotRound(room);
          if (currentRound !== null && (previousRound === null || currentRound > previousRound)) {
            for (const entry of Object.values(room.players)) {
              if (!isWaitingForRound(entry)) entry.alive = true;
            }
          }
          const released = releasePlayersForRound(room, message.snapshot.state);
          this._broadcast(room, { type: 'snapshot', snapshot: message.snapshot }, player.id);
          for (const entry of released) {
            enrollMatchPlayer(room, entry);
            this._broadcast(room, {
              type: 'player_ready',
              id: entry.id,
              round: Math.floor(Number(message.snapshot.state.round)),
            });
          }
          if (released.length) this._broadcastLobby(room);
          if (message.snapshot.state?.phase === 'gameEnd' && !room.rankedFinalized) {
            room.rankedFinalized = true;
            finalizeState = message.snapshot.state;
          }
          dirty = true;
        }
        break;
      case 'fire':
      case 'grenade':
        if (room.started && player.id !== room.hostId && player.alive !== false && !isWaitingForRound(player)) {
          this._send(this._socket(room.hostId), { ...message, shooterId: player.id });
        }
        break;
      case 'damage':
        if (room.started && player.id === room.hostId && message.targetId && message.result) {
          const target = room.players[message.targetId];
          if (target && isWaitingForRound(target)) break;
          if (target) target.alive = message.result.alive !== false;
          dirty = true;
          this._broadcast(room, { type: 'damage', ...message });
        }
        break;
      case 'event':
        if (room.started && player.id === room.hostId && message.event) {
          if (message.event === 'kill') {
            recordRankedKill(room, message.data);
            dirty = true;
          }
          this._broadcast(room, { type: 'event', event: message.event, data: message.data }, player.id);
        }
        break;
      default:
        break;
    }

    if (dirty) this._saveRoom(room);
    Object.assign(connection, room.players[connection.id] || player);
    this._syncAttachment(ws, connection);
    if (finalizeState) await this._finalizeRankedRoom(room, finalizeState);
    return connection;
  }

  _removePlayer(room, player) {
    if (!room.players[player.id]) return;
    delete room.players[player.id];
    this.connections.delete(player.id);
    this._broadcast(room, { type: 'player_left', id: player.id, name: player.name });
    const remaining = Object.values(room.players);
    if (!remaining.length) {
      this._deleteRoom(room.code);
      return;
    }
    if (room.hostId === player.id) {
      room.hostId = remaining[0].id;
      this._broadcast(room, { type: 'host_changed', hostId: room.hostId });
    }
    this._saveRoom(room);
    this._broadcastLobby(room);
  }

  async _disconnect(ws) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.id) return;
    this.connections.delete(attachment.id);
    if (!attachment.roomCode) return;
    const room = this._room(attachment.roomCode);
    const player = room?.players[attachment.id];
    if (!room || !player || !player.connected || player.connectionNonce !== attachment.connectionNonce) return;
    player.connected = false;
    player.disconnectDeadline = Date.now() + this._graceMs();
    this._saveRoom(room);
    await this._scheduleDisconnectAlarm();
  }

  async _scheduleDisconnectAlarm() {
    let earliest = Infinity;
    for (const row of this.sql.exec('SELECT data FROM rooms').toArray()) {
      let room;
      try { room = JSON.parse(row.data); } catch { continue; }
      for (const player of Object.values(room.players || {})) {
        if (!player.connected && Number.isFinite(player.disconnectDeadline)) {
          earliest = Math.min(earliest, player.disconnectDeadline);
        }
      }
    }
    if (earliest < Infinity) await this.ctx.storage.setAlarm(Math.max(Date.now(), earliest));
    else await this.ctx.storage.deleteAlarm();
  }

  async _discoverableRooms() {
    const now = Date.now();
    const summaries = [];
    for (const row of this.sql.exec('SELECT code, data FROM rooms').toArray()) {
      let room;
      try {
        room = JSON.parse(row.data);
        room.players ||= {};
      } catch {
        this._deleteRoom(row.code);
        continue;
      }

      const expired = Object.values(room.players).filter((player) =>
        (player.connected && !this._socket(player.id)) ||
        (!player.connected && (
          !Number.isFinite(player.disconnectDeadline) || player.disconnectDeadline <= now
        ))
      );
      for (const player of expired) this._removePlayer(room, player);
      if (!Object.keys(room.players).length) {
        this._deleteRoom(room.code || row.code);
        continue;
      }
      if (room.discoverable === false) continue;
      const summary = publicRoomSummary(room, MAX_PLAYERS);
      if (summary.players > 0) summaries.push(summary);
    }
    summaries.sort((left, right) =>
      Number(right.joinable) - Number(left.joinable) ||
      Number(left.started) - Number(right.started) ||
      left.code.localeCompare(right.code)
    );
    await this._scheduleDisconnectAlarm();
    return summaries;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/internal/rooms' && !request.headers.get('Upgrade')) {
      return new Response(JSON.stringify({ rooms: await this._discoverableRooms() }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const connection = newConnection();
    server.serializeAttachment(connection);
    this.connections.set(connection.id, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, rawMessage) {
    const byteLength = typeof rawMessage === 'string'
      ? new TextEncoder().encode(rawMessage).byteLength
      : rawMessage?.byteLength || 0;
    if (byteLength > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'Message too large.');
      return;
    }
    let message;
    try {
      const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage);
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    let connection = ws.deserializeAttachment() || newConnection();
    if (message.type === 'hello') connection = await this._join(ws, connection, message);
    else connection = await this._handleRoomMessage(ws, connection, message);
    ws.serializeAttachment(connection);
  }

  async webSocketClose(ws) {
    await this._disconnect(ws);
  }

  async webSocketError(ws) {
    await this._disconnect(ws);
  }

  async alarm() {
    const now = Date.now();
    const rooms = this.sql.exec('SELECT data FROM rooms').toArray();
    for (const row of rooms) {
      let room;
      try { room = JSON.parse(row.data); } catch { continue; }
      const expired = Object.values(room.players || {}).filter((player) =>
        (player.connected && !this._socket(player.id)) ||
        (!player.connected && (
          !Number.isFinite(player.disconnectDeadline) || player.disconnectDeadline <= now
        ))
      );
      for (const player of expired) this._removePlayer(room, player);
    }
    await this._scheduleDisconnectAlarm();
  }
}
