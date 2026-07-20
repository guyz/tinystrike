import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import {
  parseAllowedOrigins,
  resolveLeaderboardFilePath,
  rooms,
  server,
  startServer,
} from '../server.mjs';

function nextMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 2000);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
  });
}

function expectNoMessage(ws, type, waitMs = 80) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(new Error(`Unexpected ${type} message.`));
    };
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve();
    }, waitMs);
    ws.on('message', onMessage);
  });
}

async function openClient(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  return ws;
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for server state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('production origins and persistent data directories are normalized safely', () => {
  assert.deepEqual(
    [...parseAllowedOrigins('https://guyzyskind.com, http://localhost:9000/')],
    ['https://guyzyskind.com', 'http://localhost:9000']
  );
  assert.throws(() => parseAllowedOrigins('*'), /Invalid exact origin/);
  assert.equal(
    resolveLeaderboardFilePath({ TINY_STRIKE_DATA_DIR: '/var/lib/tiny-strike' }, '/srv/app'),
    '/var/lib/tiny-strike/leaderboard.json'
  );
  assert.equal(
    resolveLeaderboardFilePath({ TINY_STRIKE_LEADERBOARD_PATH: 'data/ranks.json' }, '/srv/app'),
    '/srv/app/data/ranks.json'
  );
});

test('two clients can create, join, start, and relay authoritative messages', async (t) => {
  startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const host = await openClient(url);
  const guest = await openClient(url);
  let late = null;
  let resumedHost = null;
  t.after(async () => {
    host.close();
    guest.close();
    if (late) late.close();
    if (resumedHost) resumedHost.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const hostWelcome = nextMessage(host, 'welcome');
  const hostInitialLobby = nextMessage(host, 'lobby');
  host.send(JSON.stringify({
    type: 'hello', action: 'create', room: 'TEST01', name: 'Alpha', characterId: '#ff00ff', mode: 'humans', mapId: 'frostline', authorityProtocol: 1,
  }));
  const hostInfo = await hostWelcome;
  assert.equal((await hostInitialLobby).players.length, 1);
  assert.equal(hostInfo.room, 'TEST01');
  assert.equal(hostInfo.mapId, 'frostline');

  const guestWelcome = nextMessage(guest, 'welcome');
  const hostLobby = nextMessage(host, 'lobby');
  guest.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'TEST01', name: 'Bravo', characterId: 'ranger', authorityProtocol: 1,
  }));
  const guestInfo = await guestWelcome;
  const lobby = await hostLobby;
  assert.equal(guestInfo.mapId, 'frostline');
  assert.equal(lobby.players.length, 2);
  assert.deepEqual(new Set(lobby.players.map((p) => p.team)), new Set(['ct', 't']));
  assert.deepEqual(new Set(lobby.players.map((p) => p.characterId)), new Set(['vanguard', 'ranger']));

  rooms.set('EMPTY1', { code: 'EMPTY1', players: new Map(), discoverable: true });
  const waitingRooms = await fetch(`http://127.0.0.1:${port}/api/rooms`).then((response) => response.json());
  assert.equal(rooms.has('EMPTY1'), false, 'empty rooms are pruned during discovery');
  assert.deepEqual(waitingRooms.rooms.map((entry) => entry.code), ['TEST01']);
  assert.deepEqual(waitingRooms.rooms[0], {
    code: 'TEST01',
    room: 'TEST01',
    mapId: 'frostline',
    mode: 'humans',
    started: false,
    phase: 'waiting',
    joinable: true,
    players: 2,
    maxPlayers: 10,
    reservedPlayers: 2,
    currentRound: null,
  });

  const hostMapLobby = nextMessage(host, 'lobby');
  const guestMapLobby = nextMessage(guest, 'lobby');
  host.send(JSON.stringify({ type: 'set_map', mapId: 'harbor' }));
  const mapLobbies = await Promise.all([hostMapLobby, guestMapLobby]);
  assert.ok(mapLobbies.every((message) => message.mapId === 'harbor'));

  const hostStart = nextMessage(host, 'match_start');
  const guestStart = nextMessage(guest, 'match_start');
  host.send(JSON.stringify({ type: 'start_match' }));
  const starts = await Promise.all([hostStart, guestStart]);
  assert.ok(starts.every((message) => message.mapId === 'harbor'));
  assert.equal(starts[0].matchId, starts[1].matchId);

  host.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: starts[0].authorityEpoch,
    snapshot: { state: { round: 3, phase: 'live', scores: { ct: 1, t: 1 } }, bots: [] },
  }));
  await waitFor(() => rooms.get('TEST01')?.currentRound === 3);

  late = await openClient(url);
  const lateWelcome = nextMessage(late, 'welcome');
  const lateResume = nextMessage(late, 'match_resume');
  late.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'TEST01', name: 'Charlie', characterId: 'shadow', authorityProtocol: 1,
  }));
  const lateInfo = await lateWelcome;
  const resume = await lateResume;
  assert.equal(lateInfo.lateJoin, true);
  assert.equal(lateInfo.waitingForRound, true);
  assert.equal(lateInfo.eligibleRound, 4);
  assert.equal(resume.snapshot.state.round, 3);
  assert.equal(resume.spectating, true);
  assert.equal(resume.players.find((entry) => entry.id === lateInfo.id).alive, false);
  assert.equal(
    rooms.get('TEST01').matchPlayers.some((entry) => entry.id === lateInfo.id),
    false,
    'an unreleased spectator is not enrolled for ranked match credit'
  );

  const activeRooms = await fetch(`http://127.0.0.1:${port}/api/rooms`).then((response) => response.json());
  assert.equal(activeRooms.rooms[0].started, true);
  assert.equal(activeRooms.rooms[0].phase, 'live');
  assert.equal(activeRooms.rooms[0].currentRound, 3);
  assert.equal(activeRooms.rooms[0].players, 3);
  assert.equal(activeRooms.rooms[0].joinable, true);
  assert.equal('hostId' in activeRooms.rooms[0], false);

  const blockedState = expectNoMessage(host, 'player_state');
  late.send(JSON.stringify({ type: 'player_state', state: { round: 3, alive: true, pos: { x: 9, y: 9, z: 9 } } }));
  await blockedState;
  assert.equal(rooms.get('TEST01').players.get(lateInfo.id).alive, false);

  const blockedFire = expectNoMessage(host, 'fire');
  late.send(JSON.stringify({
    type: 'fire', weaponId: 'glock', origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 },
  }));
  await blockedFire;

  const playerReady = nextMessage(late, 'player_ready');
  host.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: starts[0].authorityEpoch,
    snapshot: { state: { round: 4, phase: 'freeze', scores: { ct: 1, t: 1 } }, bots: [] },
  }));
  assert.deepEqual(await playerReady, { type: 'player_ready', id: lateInfo.id, round: 4 });
  assert.equal(rooms.get('TEST01').players.get(lateInfo.id).joinRound, null);
  assert.equal(rooms.get('TEST01').players.get(lateInfo.id).alive, true);
  assert.equal(rooms.get('TEST01').matchPlayers.some((entry) => entry.id === lateInfo.id), true);

  const releasedState = nextMessage(host, 'player_state');
  late.send(JSON.stringify({ type: 'player_state', state: { round: 4, alive: true, pos: { x: 9, y: 2, z: 1 } } }));
  assert.equal((await releasedState).id, lateInfo.id);

  const relayedState = nextMessage(host, 'player_state');
  guest.send(JSON.stringify({
    type: 'player_state', state: { round: 4, pos: { x: 1, y: 2, z: 3 }, alive: true, characterId: 'url(javascript:bad)' },
  }));
  const stateMessage = await relayedState;
  assert.equal(stateMessage.state.pos.x, 1);
  assert.equal(stateMessage.state.characterId, 'vanguard');

  const relayedShot = nextMessage(host, 'fire');
  guest.send(JSON.stringify({
    type: 'fire', weaponId: 'glock', origin: { x: 0, y: 1, z: 0 }, dir: { x: 0, y: 0, z: -1 },
  }));
  assert.equal((await relayedShot).shooterId, guestInfo.id);

  const immediateHandoff = nextMessage(guest, 'host_changed');
  host.terminate();
  const handoff = await immediateHandoff;
  assert.equal(handoff.hostId, guestInfo.id, 'authority leaves a disconnected host immediately');
  assert.ok(handoff.authorityEpoch > starts[0].authorityEpoch);
  await waitFor(() => rooms.get('TEST01')?.players.get(hostInfo.id)?.connected === false);
  assert.equal(rooms.get('TEST01').players.has(hostInfo.id), true, 'the reconnect seat remains reserved');
  assert.equal(rooms.get('TEST01').hostId, guestInfo.id);
  guest.send(JSON.stringify({
    type: 'damage',
    authorityEpoch: handoff.authorityEpoch,
    targetId: hostInfo.id,
    result: { health: 0, armor: 0, alive: false, amount: 100, weapon: 'ak47' },
  }));
  await waitFor(() => rooms.get('TEST01')?.players.get(hostInfo.id)?.state?.alive === false);
  resumedHost = await openClient(url);
  const resumedWelcome = nextMessage(resumedHost, 'welcome');
  const resumedMatch = nextMessage(resumedHost, 'match_resume');
  resumedHost.send(JSON.stringify({
    type: 'hello',
    action: 'reconnect',
    room: 'TEST01',
    reconnectToken: hostInfo.reconnectToken,
    authorityProtocol: 1,
  }));
  const resumedInfo = await resumedWelcome;
  assert.equal(resumedInfo.id, hostInfo.id);
  assert.equal(resumedInfo.resumed, true);
  assert.equal(resumedInfo.hostId, guestInfo.id, 'reconnecting does not steal authority back');
  const resumedMatchInfo = await resumedMatch;
  assert.equal(resumedMatchInfo.matchId, starts[0].matchId);
  assert.equal(resumedMatchInfo.hostId, guestInfo.id);
  const resumedCanonical = resumedMatchInfo.snapshot.players.find((entry) => entry.id === hostInfo.id);
  assert.equal(resumedCanonical.state.alive, false);
  assert.equal(resumedCanonical.state.health, 0);

  const resumedState = nextMessage(guest, 'player_state');
  resumedHost.send(JSON.stringify({
    type: 'player_state', state: { round: 4, pos: { x: 4, y: 2, z: 1 }, alive: true },
  }));
  assert.equal((await resumedState).id, hostInfo.id);

  resumedHost.terminate();
  await waitFor(() => rooms.get('TEST01')?.players.get(hostInfo.id)?.connected === false);
  guest.send(JSON.stringify({
    type: 'damage',
    authorityEpoch: handoff.authorityEpoch,
    targetId: lateInfo.id,
    result: { health: 0, armor: 0, alive: false, amount: 100, weapon: 'ak47' },
  }));
  await waitFor(() => rooms.get('TEST01')?.players.get(lateInfo.id)?.alive === false);
  guest.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: handoff.authorityEpoch,
    snapshot: { state: { round: 5, phase: 'freeze', scores: { ct: 1, t: 1 } }, bots: [] },
  }));
  await waitFor(() => rooms.get('TEST01')?.currentRound === 5);
  late.send(JSON.stringify({
    type: 'player_state',
    state: { round: 4, pos: { x: 8, y: 2, z: 1 }, health: 0, armor: 0, alive: false },
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    rooms.get('TEST01').players.get(lateInfo.id).alive,
    true,
    'an in-flight prior-round player state cannot undo the authoritative respawn',
  );
  assert.equal(rooms.get('TEST01').players.get(lateInfo.id).state.health, 100);

  resumedHost = await openClient(url);
  const nextRoundWelcome = nextMessage(resumedHost, 'welcome');
  const nextRoundResume = nextMessage(resumedHost, 'match_resume');
  resumedHost.send(JSON.stringify({
    type: 'hello',
    action: 'reconnect',
    room: 'TEST01',
    reconnectToken: hostInfo.reconnectToken,
    authorityProtocol: 1,
  }));
  await nextRoundWelcome;
  const nextRoundMatch = await nextRoundResume;
  const resetCanonical = nextRoundMatch.snapshot.players.find((entry) => entry.id === hostInfo.id);
  assert.equal(resetCanonical.state.alive, true, 'the next round revives a disconnected reserved seat');
  assert.equal(resetCanonical.state.health, 100, 'the next round restores canonical health before reconnect');
});

test('a stalled browser host is fenced out and an active peer keeps one canonical timeline', async (t) => {
  startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const host = await openClient(url);
  const guest = await openClient(url);
  t.after(async () => {
    host.close();
    guest.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const hostWelcome = nextMessage(host, 'welcome');
  host.send(JSON.stringify({
    type: 'hello', action: 'create', room: 'LEASE1', name: 'Host', mode: 'humans', mapId: 'dustyard', authorityProtocol: 1,
  }));
  const hostInfo = await hostWelcome;

  const guestWelcome = nextMessage(guest, 'welcome');
  guest.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'LEASE1', name: 'Guest', authorityProtocol: 1,
  }));
  const guestInfo = await guestWelcome;

  const hostStart = nextMessage(host, 'match_start');
  const guestStart = nextMessage(guest, 'match_start');
  host.send(JSON.stringify({ type: 'start_match' }));
  const [hostMatch] = await Promise.all([hostStart, guestStart]);

  host.send(JSON.stringify({
    type: 'player_state',
    state: { round: 1, pos: { x: 1, y: 2, z: 3 }, alive: true, characterId: 'vanguard' },
  }));
  host.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: hostMatch.authorityEpoch,
    snapshot: { state: { round: 2, phase: 'live', timer: 60, scores: { ct: 0, t: 0 } }, bots: [] },
  }));
  await waitFor(() => rooms.get('LEASE1')?.snapshotSeq === 1);

  const room = rooms.get('LEASE1');
  room.lastAuthoritySnapshotAt = Date.now() - 2_000;
  const hostHandoff = nextMessage(host, 'host_changed');
  const guestHandoff = nextMessage(guest, 'host_changed');
  guest.send(JSON.stringify({
    type: 'player_state',
    state: { round: 2, pos: { x: 9, y: 2, z: 1 }, alive: true, characterId: 'ranger' },
  }));
  const [hostChange, guestChange] = await Promise.all([hostHandoff, guestHandoff]);
  assert.equal(hostChange.hostId, guestInfo.id);
  assert.equal(guestChange.hostId, guestInfo.id);
  assert.equal(hostChange.authorityEpoch, hostMatch.authorityEpoch + 1);
  assert.equal(room.hostId, guestInfo.id);
  assert.equal(hostChange.snapshotSeq, 2);
  assert.ok(hostChange.snapshot.state.timer < 59, 'handoff accounts for elapsed wall time');

  const fencedSeq = room.snapshotSeq;
  const fencedRound = room.currentRound;
  host.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: hostMatch.authorityEpoch,
    snapshot: { state: { round: 99, phase: 'gameEnd', timer: 0, scores: { ct: 99, t: 0 } }, bots: [] },
  }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(room.snapshotSeq, fencedSeq, 'the previous authority cannot append stale state');
  assert.equal(room.currentRound, fencedRound);

  const noForgedDamage = expectNoMessage(guest, 'damage');
  host.send(JSON.stringify({
    type: 'damage', authorityEpoch: hostMatch.authorityEpoch,
    targetId: guestInfo.id, result: { health: 0, alive: false },
  }));
  await noForgedDamage;

  const canonicalSnapshot = nextMessage(host, 'snapshot');
  guest.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: hostMatch.authorityEpoch + 1,
    snapshot: { state: { round: 3, phase: 'freeze', timer: 9, scores: { ct: 1, t: 0 } }, bots: [] },
  }));
  const accepted = await canonicalSnapshot;
  assert.equal(accepted.hostId, guestInfo.id);
  assert.equal(accepted.authorityEpoch, hostMatch.authorityEpoch + 1);
  assert.equal(accepted.snapshotSeq, 3);
  assert.deepEqual(
    new Set(accepted.snapshot.players.map((entry) => entry.id)),
    new Set([hostInfo.id, guestInfo.id]),
  );

  const immediateReturn = nextMessage(host, 'host_changed');
  guest.terminate();
  const returned = await immediateReturn;
  assert.equal(returned.hostId, hostInfo.id);
  assert.equal(room.hostId, hostInfo.id);
  assert.equal(room.players.get(guestInfo.id).connected, false);
  assert.equal(room.players.has(guestInfo.id), true, 'disconnect migration does not destroy the reserved seat');
});

test('an old authority epoch stays fenced after the same player regains the lease', async (t) => {
  startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const alpha = await openClient(url);
  const bravo = await openClient(url);
  t.after(async () => {
    alpha.close();
    bravo.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const alphaWelcome = nextMessage(alpha, 'welcome');
  alpha.send(JSON.stringify({
    type: 'hello', action: 'create', room: 'EPOCH1', name: 'Alpha', mode: 'humans', mapId: 'dustyard', authorityProtocol: 1,
  }));
  const alphaInfo = await alphaWelcome;

  const bravoWelcome = nextMessage(bravo, 'welcome');
  bravo.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'EPOCH1', name: 'Bravo', authorityProtocol: 1,
  }));
  const bravoInfo = await bravoWelcome;

  const alphaStart = nextMessage(alpha, 'match_start');
  const bravoStart = nextMessage(bravo, 'match_start');
  alpha.send(JSON.stringify({ type: 'start_match' }));
  const [started] = await Promise.all([alphaStart, bravoStart]);
  const alphaFirstEpoch = started.authorityEpoch;

  alpha.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: alphaFirstEpoch,
    snapshot: { state: { round: 2, phase: 'live', timer: 70, scores: { ct: 0, t: 0 } }, bots: [] },
  }));
  const room = rooms.get('EPOCH1');
  await waitFor(() => room.snapshotSeq === 1);

  room.lastAuthoritySnapshotAt = Date.now() - 2_000;
  const toBravo = nextMessage(bravo, 'host_changed');
  bravo.send(JSON.stringify({
    type: 'player_state',
    state: { round: 2, pos: { x: 2, y: 0, z: 2 }, alive: true, characterId: 'ranger' },
  }));
  const bravoLease = await toBravo;
  assert.equal(bravoLease.hostId, bravoInfo.id);

  const backToAlpha = nextMessage(alpha, 'host_changed');
  bravo.send(JSON.stringify({
    type: 'yield_authority',
    authorityEpoch: bravoLease.authorityEpoch,
  }));
  const alphaLease = await backToAlpha;
  assert.equal(alphaLease.hostId, alphaInfo.id);
  assert.ok(alphaLease.authorityEpoch > alphaFirstEpoch);

  const fencedSeq = room.snapshotSeq;
  const fencedRound = room.currentRound;
  alpha.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: alphaFirstEpoch,
    snapshot: { state: { round: 99, phase: 'gameEnd', timer: 0, scores: { ct: 99, t: 0 } }, bots: [] },
  }));
  alpha.send(JSON.stringify({
    type: 'yield_authority',
    authorityEpoch: alphaFirstEpoch,
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(room.hostId, alphaInfo.id, 'a delayed old yield cannot surrender the new lease');
  assert.equal(room.snapshotSeq, fencedSeq, 'a delayed old snapshot cannot append to the new timeline');
  assert.equal(room.currentRound, fencedRound);

  alpha.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: alphaLease.authorityEpoch,
    snapshot: { state: { round: 3, phase: 'freeze', timer: 8, scores: { ct: 1, t: 0 } }, bots: [] },
  }));
  await waitFor(() => room.snapshotSeq === fencedSeq + 1);
  assert.equal(room.currentRound, 3, 'the current lease still advances normally');
});

test('a legacy peer cannot inherit a fenced authority lease', async (t) => {
  startServer(0);
  await once(server, 'listening');
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}/ws`;
  const host = await openClient(url);
  const legacy = await openClient(url);
  let lateLegacy = null;
  t.after(async () => {
    host.close();
    legacy.close();
    if (lateLegacy) lateLegacy.close();
    await new Promise((resolve) => server.close(resolve));
  });

  const hostWelcome = nextMessage(host, 'welcome');
  host.send(JSON.stringify({
    type: 'hello', action: 'create', room: 'LEGACY', name: 'Modern Host',
    mode: 'humans', mapId: 'dustyard', authorityProtocol: 1,
  }));
  const hostInfo = await hostWelcome;

  const legacyWelcome = nextMessage(legacy, 'welcome');
  legacy.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'LEGACY', name: 'Old Tab',
  }));
  await legacyWelcome;

  const hostStart = nextMessage(host, 'match_start');
  const legacyStart = nextMessage(legacy, 'match_start');
  host.send(JSON.stringify({ type: 'start_match' }));
  const [started] = await Promise.all([hostStart, legacyStart]);

  host.send(JSON.stringify({
    type: 'snapshot',
    authorityEpoch: started.authorityEpoch,
    snapshot: {
      state: { round: 2, phase: 'live', timer: 60, scores: { ct: 0, t: 0 } },
      bots: [],
    },
  }));
  const room = rooms.get('LEGACY');
  await waitFor(() => room.snapshotSeq === 1);
  room.lastAuthoritySnapshotAt = Date.now() - 2_000;

  const noLegacyPromotion = expectNoMessage(legacy, 'host_changed', 120);
  legacy.send(JSON.stringify({
    type: 'player_state',
    state: { pos: { x: 2, y: 0, z: 2 }, alive: true, characterId: 'vanguard' },
  }));
  await noLegacyPromotion;

  assert.equal(room.hostId, hostInfo.id);
  assert.equal(room.players.get(hostInfo.id).authorityProtocol, 1);
  assert.equal(
    [...room.players.values()].find((player) => player.id !== hostInfo.id).authorityProtocol,
    0,
  );

  host.terminate();
  await waitFor(() => room.players.get(hostInfo.id)?.connected === false);
  assert.equal(room.hostId, hostInfo.id, 'disconnect cannot promote the connected legacy peer');

  lateLegacy = await openClient(url);
  const lateWelcome = nextMessage(lateLegacy, 'welcome');
  const lateResume = nextMessage(lateLegacy, 'match_resume');
  const noJoinPromotion = expectNoMessage(legacy, 'host_changed', 120);
  lateLegacy.send(JSON.stringify({
    type: 'hello', action: 'join', room: 'LEGACY', name: 'Another Old Tab',
  }));
  const lateInfo = await lateWelcome;
  const resumed = await lateResume;
  await noJoinPromotion;
  assert.equal(lateInfo.hostId, hostInfo.id, 'legacy late join cannot bypass candidate filtering');
  assert.equal(resumed.hostId, hostInfo.id);
  assert.equal(room.hostId, hostInfo.id);
});
