import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, normalize, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8020;
const MAX_PLAYERS = 10;
const rooms = new Map();

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

function makeRoomCode() {
  let code;
  do code = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
  return code;
}

function publicPlayer(player, hostId) {
  return {
    id: player.id,
    name: player.name,
    team: player.team,
    host: player.id === hostId,
    alive: player.alive,
  };
}

function roomPayload(room) {
  return {
    type: 'lobby',
    room: room.code,
    mode: room.mode,
    started: room.started,
    hostId: room.hostId,
    players: [...room.players.values()].map((p) => publicPlayer(p, room.hostId)),
  };
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
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

function chooseTeam(room) {
  let ct = 0;
  let t = 0;
  for (const p of room.players.values()) p.team === 't' ? t++ : ct++;
  return ct <= t ? 'ct' : 't';
}

function leaveRoom(player) {
  const room = player.roomCode ? rooms.get(player.roomCode) : null;
  if (!room || !room.players.delete(player.id)) return;

  broadcast(room, { type: 'player_left', id: player.id, name: player.name });
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id) {
    room.hostId = room.players.keys().next().value;
    broadcast(room, { type: 'host_changed', hostId: room.hostId });
  }
  broadcastLobby(room);
}

function joinRoom(ws, client, msg) {
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
      hostId: client.id,
      players: new Map(),
      started: false,
    };
    rooms.set(code, room);
  } else {
    if (!room) return send(ws, { type: 'error', message: 'Room not found.' });
    if (room.started) return send(ws, { type: 'error', message: 'That match has already started.' });
    if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'That room is full.' });
  }

  client.name = cleanName(msg.name);
  client.roomCode = room.code;
  client.team = chooseTeam(room);
  client.alive = true;
  room.players.set(client.id, client);

  send(ws, {
    type: 'welcome',
    id: client.id,
    room: room.code,
    hostId: room.hostId,
    mode: room.mode,
  });
  broadcastLobby(room);
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

  room.started = true;
  for (const p of room.players.values()) p.alive = true;
  broadcast(room, {
    type: 'match_start',
    room: room.code,
    mode: room.mode,
    hostId: room.hostId,
    players: [...room.players.values()].map((p) => publicPlayer(p, room.hostId)),
  });
}

function handleRoomMessage(client, msg) {
  const room = client.roomCode ? rooms.get(client.roomCode) : null;
  if (!room) return send(client.ws, { type: 'error', message: 'Join a room first.' });

  switch (msg.type) {
    case 'set_team': {
      if (room.started) return;
      const team = msg.team === 't' ? 't' : 'ct';
      let count = 0;
      for (const p of room.players.values()) if (p.team === team && p.id !== client.id) count++;
      if (count >= 5) return send(client.ws, { type: 'error', message: 'That team is full.' });
      client.team = team;
      broadcastLobby(room);
      break;
    }
    case 'set_mode':
      if (!room.started && room.hostId === client.id) {
        room.mode = msg.mode === 'humans' ? 'humans' : 'mixed';
        broadcastLobby(room);
      }
      break;
    case 'start_match':
      startMatch(room, client);
      break;
    case 'player_state': {
      if (!room.started || !msg.state) return;
      const s = msg.state;
      if (typeof s.alive === 'boolean') client.alive = s.alive;
      broadcast(room, { type: 'player_state', id: client.id, state: s }, client.id);
      break;
    }
    case 'snapshot':
      if (room.started && room.hostId === client.id && msg.snapshot) {
        broadcast(room, { type: 'snapshot', snapshot: msg.snapshot }, client.id);
      }
      break;
    case 'fire':
    case 'grenade': {
      if (!room.started || client.id === room.hostId) return;
      const host = room.players.get(room.hostId);
      if (host) send(host.ws, { ...msg, shooterId: client.id });
      break;
    }
    case 'damage':
      if (room.started && client.id === room.hostId && msg.targetId && msg.result) {
        const target = room.players.get(msg.targetId);
        if (target) target.alive = msg.result.alive !== false;
        broadcast(room, { type: 'damage', ...msg });
      }
      break;
    case 'event':
      if (room.started && client.id === room.hostId && msg.event) {
        broadcast(room, { type: 'event', event: msg.event, data: msg.data }, client.id);
      }
      break;
    default:
      break;
  }
}

const server = createServer((req, res) => {
  const rawPath = new URL(req.url || '/', 'http://localhost').pathname;
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

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws) => {
  const client = {
    id: randomUUID().replace(/-/g, '').slice(0, 12),
    ws,
    name: 'Operative',
    team: 'ct',
    roomCode: null,
    alive: true,
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') joinRoom(ws, client, msg);
    else handleRoomMessage(client, msg);
  });
  ws.on('close', () => leaveRoom(client));
  ws.on('error', () => {});
});

function startServer(port = PORT) {
  return server.listen(port, () => {
    const address = server.address();
    const activePort = address && typeof address === 'object' ? address.port : port;
    console.log(`OPERATION GOLDENEYE server: http://localhost:${activePort}`);
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();

export { server, rooms, startServer };
