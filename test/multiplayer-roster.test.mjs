import assert from 'node:assert/strict';
import test from 'node:test';

import Multiplayer, {
  RESUME_TICKET_KEY,
  botCountsForRoster,
  botCountsForSnapshot,
  parseResumeTicket,
  shouldReuseResumeOwner,
  unrankedRetryHello,
} from '../src/network/multiplayer.js';

function human(id, team, joinRound = null) {
  return { id, team, joinRound };
}

test('mixed rooms fill each side to five while allowing ten humans', () => {
  assert.deepEqual(botCountsForRoster([
    human('a', 'ct'),
    human('b', 't'),
    human('c', 'ct'),
  ], 'mixed'), { ct: 3, t: 4 });

  assert.deepEqual(botCountsForRoster([
    human('a', 'ct'),
    human('b', 't'),
    human('c', 'ct'),
    human('d', 't'),
  ], 'mixed'), { ct: 3, t: 3 });

  const fullRoom = Array.from({ length: 10 }, (_, index) =>
    human(String(index), index < 5 ? 'ct' : 't')
  );
  assert.deepEqual(botCountsForRoster(fullRoom, 'mixed'), { ct: 0, t: 0 });
  assert.deepEqual(botCountsForRoster(fullRoom, 'humans'), { ct: 0, t: 0 });
});

test('a late human replaces a bot only on their eligible round', () => {
  const roster = [
    human('host', 'ct'),
    human('guest', 't'),
    human('late', 'ct', 4),
  ];
  assert.deepEqual(botCountsForRoster(roster, 'mixed', 3), { ct: 4, t: 4 });
  assert.deepEqual(botCountsForRoster(roster, 'mixed', 4), { ct: 3, t: 4 });
});

test('late spectators mirror the host snapshot bot roster for the current round', () => {
  assert.deepEqual(botCountsForSnapshot({
    bots: [
      { team: 'ct' }, { team: 'ct' }, { team: 'ct' }, { team: 'ct' },
      { team: 't' }, { team: 't' }, { team: 't' }, { team: 't' },
    ],
  }), { ct: 4, t: 4 });
});

test('a second window retries an occupied ranked identity as an unranked guest', () => {
  const hello = {
    type: 'hello',
    action: 'join',
    room: 'ROOM01',
    name: 'Second Window',
    leaderboardToken: 'shared-browser-token',
  };

  assert.deepEqual(unrankedRetryHello({
    type: 'error',
    code: 'ranked_identity_in_use',
    message: 'That ranked identity is already playing in this room.',
  }, hello), {
    ...hello,
    leaderboardToken: '',
  });

  assert.deepEqual(unrankedRetryHello({
    type: 'error',
    message: 'That ranked identity is already playing in this room. Reconnect the existing player instead.',
  }, hello), {
    ...hello,
    leaderboardToken: '',
  }, 'the deployed pre-code server remains compatible during rollout');

  assert.equal(unrankedRetryHello({ type: 'error', code: 'room_full' }, hello), null);
  assert.equal(unrankedRetryHello({
    type: 'error', code: 'ranked_identity_in_use',
  }, { ...hello, leaderboardToken: '' }), null, 'the fallback cannot retry forever');
});

test('joining does not rename the shared ranked profile before identity ownership is known', async () => {
  const updates = [];
  const leaderboardNames = [];
  let sentHello = null;
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: {
      profile: {
        name: 'Primary Profile',
        characterId: 'ranger',
        update(value) { updates.push(value); },
      },
      leaderboard: {
        setPlayerName(value) { leaderboardNames.push(value); },
        async ensureSession() { return 'shared-browser-token'; },
      },
      selectedMapId: 'harbor',
    },
    socket: null,
    _connecting: false,
    _ui: {
      name: { value: 'Second Window' },
      room: { value: 'ROOM01' },
      mode: { value: 'mixed' },
    },
    _setConnecting() {},
    _status() {},
    _openSocket(hello) { sentHello = hello; },
  });

  await multiplayer.connect('join');

  assert.equal(updates.length, 0);
  assert.equal(leaderboardNames.length, 0);
  assert.equal(sentHello.name, 'Second Window');
  assert.equal(sentHello.leaderboardToken, 'shared-browser-token');
  assert.deepEqual(multiplayer._pendingProfile, {
    name: 'Second Window', characterId: 'ranger',
  });
});

test('only a non-conflicting room join commits its callsign to shared profile storage', () => {
  const updates = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: { profile: { update(value) { updates.push(value); } } },
    _pendingProfile: { name: 'Guest Tab', characterId: 'shadow' },
    _unrankedIdentityConflict: true,
  });

  multiplayer._commitPendingProfile();
  assert.deepEqual(updates, []);

  multiplayer._pendingProfile = { name: 'Primary Renamed', characterId: 'shadow' };
  multiplayer._unrankedIdentityConflict = false;
  multiplayer._commitPendingProfile();
  assert.deepEqual(updates, [{ name: 'Primary Renamed', characterId: 'shadow' }]);
});

function authorityClient(localId = 'new-host') {
  const applied = [];
  const sent = [];
  const events = [];
  const resumed = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: {
      events: { emit(name, data) { events.push({ name, data }); } },
      bots: { resumeNetworkAuthority() { resumed.push('bots'); } },
      combat: { resumeNetworkAuthority() { resumed.push('combat'); } },
    },
    active: true,
    connected: true,
    localId,
    hostId: 'old-host',
    isHost: false,
    _authorityEpoch: 4,
    _snapshotSeq: 20,
    _serverTime: 100,
    _sendAccum: 0.4,
    _snapshotAccum: 0.7,
    _yieldedAuthorityEpoch: null,
    _renderLobby() {},
    _applySnapshot(snapshot) {
      applied.push({ snapshot, wasAuthority: this.isHost });
      return true;
    },
    _makeSnapshot() { return { state: { round: 7, phase: 'live' }, bots: [] }; },
    _send(message) { sent.push(message); },
  });
  return { multiplayer, applied, sent, events, resumed };
}

test('ordered snapshots apply once and a handoff hydrates before becoming authority', () => {
  const { multiplayer, applied, sent, events, resumed } = authorityClient();

  multiplayer._onMessage({
    type: 'snapshot',
    hostId: 'old-host',
    authorityEpoch: 4,
    snapshotSeq: 21,
    serverTime: 110,
    snapshot: { state: { round: 6, timer: 31 } },
  });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].wasAuthority, false);
  assert.equal(multiplayer._snapshotSeq, 21);
  assert.equal(multiplayer._serverTime, 110);

  multiplayer._onMessage({
    type: 'host_changed',
    hostId: 'new-host',
    authorityEpoch: 5,
    snapshotSeq: 22,
    serverTime: 120,
    snapshot: { state: { round: 6, timer: 29 } },
  });

  assert.equal(applied.length, 2);
  assert.equal(applied[1].wasAuthority, false, 'canonical handoff state applies before promotion');
  assert.equal(multiplayer.hostId, 'new-host');
  assert.equal(multiplayer.isHost, true);
  assert.equal(multiplayer._authorityEpoch, 5);
  assert.equal(multiplayer._snapshotSeq, 22);
  assert.equal(multiplayer._sendAccum, 0);
  assert.equal(multiplayer._snapshotAccum, 0);
  assert.deepEqual(resumed, ['bots', 'combat'], 'transient simulation resumes only after handoff state applies');
  assert.deepEqual(events, [{
    name: 'network:host',
    data: { hostId: 'new-host', authorityEpoch: 5 },
  }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[0].authorityEpoch, 5);
  assert.equal(sent[0].snapshot.state.round, 7);

  multiplayer._onMessage({
    type: 'host_changed', hostId: 'new-host', authorityEpoch: 5, snapshotSeq: 22,
    snapshot: { state: { round: 1, timer: 1 } },
  });
  assert.equal(applied.length, 2, 'duplicate handoff snapshot is ignored');
  assert.equal(sent.length, 1, 'duplicate handoff does not announce authority twice');
});

test('stale epochs and non-increasing snapshot sequences cannot roll authority back', () => {
  const { multiplayer, applied, sent } = authorityClient();

  multiplayer._onMessage({
    type: 'snapshot', hostId: 'old-host', authorityEpoch: 4, snapshotSeq: 20,
    snapshot: { state: { timer: 1 } },
  });
  multiplayer._onMessage({
    type: 'snapshot', hostId: 'old-host', authorityEpoch: 4, snapshotSeq: 19,
    snapshot: { state: { timer: 2 } },
  });
  multiplayer._onMessage({
    type: 'host_changed', hostId: 'new-host', authorityEpoch: 3, snapshotSeq: 99,
    snapshot: { state: { timer: 3 } },
  });

  assert.equal(applied.length, 0);
  assert.equal(sent.length, 0);
  assert.equal(multiplayer.hostId, 'old-host');
  assert.equal(multiplayer.isHost, false);
  assert.equal(multiplayer._authorityEpoch, 4);
  assert.equal(multiplayer._snapshotSeq, 20);
});

test('canonical snapshot players update remote actors but never overwrite the local player', () => {
  const appliedPlayers = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    localId: 'local',
    waitingForNextRound: false,
    joinRound: null,
    game: { events: { emit() {} }, rounds: null, bots: null, hud: null },
    prepareRoundRoster() {},
    _applyPlayerState(id, state) { appliedPlayers.push({ id, state }); },
  });

  assert.equal(multiplayer._applySnapshot({
    players: [
      { id: 'local', state: { health: 1 } },
      { id: 'remote-a', state: { health: 72, alive: true } },
      { id: 'remote-b', health: 0, alive: false },
    ],
  }), true);
  assert.deepEqual(appliedPlayers, [
    { id: 'remote-a', state: { health: 72, alive: true } },
    { id: 'remote-b', state: { id: 'remote-b', health: 0, alive: false } },
  ]);
});

test('match-resume can reconcile missed local damage without overwriting local pose', () => {
  const applied = [];
  const player = {
    alive: true,
    health: 100,
    armor: 50,
    position: { x: 9, y: 1, z: 4 },
    applyNetworkDamage(result) {
      applied.push(result);
      this.health = result.health;
      this.armor = result.armor;
      this.alive = result.alive;
    },
  };
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    localId: 'local',
    game: { player },
  });

  assert.equal(multiplayer._applyLocalCanonicalState({
    players: [{
      id: 'local',
      state: { pos: { x: -50, y: 0, z: -50 }, health: 0, armor: 8, alive: false },
    }],
  }), true);
  assert.equal(player.alive, false);
  assert.equal(player.health, 0);
  assert.equal(player.armor, 8);
  assert.deepEqual(player.position, { x: 9, y: 1, z: 4 });
  assert.equal(applied.length, 1);
});

test('foreground canonical sync restores local pose, inventory, money, and kit', () => {
  const inventory = { currentId: 'ak47', slots: { 1: 'ak47', 2: 'usp', 3: 'knife', 4: [] }, ammo: {} };
  const appliedInventories = [];
  const player = {
    alive: true,
    health: 100,
    armor: 0,
    hasKit: false,
    yaw: 0,
    pitch: 0,
    crouching: false,
    walking: false,
    onGround: true,
    position: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    velocity: { set(x, y, z) { this.value = [x, y, z]; } },
  };
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    localId: 'local',
    game: {
      player,
      state: { money: 800 },
      weapons: { applyNetworkSnapshot(value) { appliedInventories.push(value); } },
    },
  });

  assert.equal(multiplayer._applyLocalCanonicalState({
    state: { round: 4 },
    players: [{
      id: 'local',
      state: {
        round: 4,
        pos: { x: 14, y: 2, z: -8 }, yaw: 1.2, pitch: -0.2,
        health: 73, armor: 41, alive: true, hasKit: true,
        crouching: true, walking: true, onGround: false,
        money: 4_900, inventory,
      },
    }],
  }, { includePose: true, includeLoadout: true }), true);
  assert.deepEqual({ x: player.position.x, y: player.position.y, z: player.position.z }, { x: 14, y: 2, z: -8 });
  assert.equal(player.yaw, 1.2);
  assert.equal(player.pitch, -0.2);
  assert.equal(player.hasKit, true);
  assert.deepEqual(player.velocity.value, [0, 0, 0]);
  assert.equal(multiplayer.game.state.money, 4_900);
  assert.deepEqual(appliedInventories, [inventory]);
});

test('foreground recovery requests canonical state once and fences gameplay until it arrives', () => {
  const sent = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: {
      events: { emit() {} },
      input: { releaseVirtualControls() {} },
      combat: { suspendNetworkAuthority() {} },
    },
    active: true,
    connected: true,
    roomCode: 'ROOM01',
    reconnectToken: 'resume-token',
    socket: { readyState: 1 },
    syncing: false,
    isHost: true,
    _authoritySuspended: false,
    _resumeSyncTimer: null,
    _ui: null,
    _send(message) { sent.push(message); },
  });

  assert.equal(multiplayer._requestCanonicalSync('visibility'), true);
  assert.equal(multiplayer._requestCanonicalSync('pageshow'), false, 'duplicate foreground events are deduplicated');
  assert.equal(multiplayer.syncing, true);
  assert.equal(multiplayer._authoritySuspended, true);
  assert.equal(multiplayer.isAuthority(), false);
  assert.deepEqual(sent, [{ type: 'sync_request', reason: 'visibility' }]);
  clearTimeout(multiplayer._resumeSyncTimer);
});

test('a server-replaced socket cannot reconnect and steal the seat back', () => {
  const socket = {};
  let reconnects = 0;
  let ownershipChecks = 0;
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    socket,
    connected: true,
    active: true,
    isHost: false,
    localId: 'local',
    roomCode: 'ROOM01',
    reconnectToken: 'token',
    _localReconnectSockets: new WeakSet(),
    _setConnecting() {},
    _startCanonicalSync() { this.syncing = true; },
    _status() {},
    _scheduleResumeOwnershipCheck() { ownershipChecks++; },
    _scheduleReconnect() { reconnects++; },
    game: { combat: {} },
  });

  assert.equal(multiplayer._onSocketClose(socket, { code: 4001 }), true);
  assert.equal(multiplayer._sessionTakenOver, true);
  assert.equal(multiplayer.syncing, true);
  assert.equal(reconnects, 0);
  assert.equal(ownershipChecks, 1);
});

test('foreground restarts an already-syncing recovery with no live socket', () => {
  let forced = 0;
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    active: true,
    connected: false,
    syncing: true,
    socket: null,
    roomCode: 'ROOM01',
    reconnectToken: 'token',
    _sessionTakenOver: false,
    _forceReconnectForSync() { forced++; return true; },
  });
  assert.equal(multiplayer._requestCanonicalSync('pageshow'), true);
  assert.equal(forced, 1);
});

test('resume owners survive reloads but duplicated navigations receive a new owner', () => {
  assert.equal(shouldReuseResumeOwner('reload'), true);
  assert.equal(shouldReuseResumeOwner('back_forward'), true);
  assert.equal(shouldReuseResumeOwner('navigate'), false);
});

test('unranked resume tickets persist by seat without becoming ranked', () => {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    roomCode: 'ROOM01', reconnectToken: 'guest-token', _resumeOwnerId: 'guest-tab',
    _canPersistResumeTicket: false, _resumeDisabled: false,
    _resumeStorage: storage, _tabResumeStorage: storage,
  });
  assert.equal(multiplayer._persistResumeTicket(), true);
  const ticket = multiplayer._resumeSeatTickets()[0];
  assert.equal(ticket.ranked, false);
  assert.equal(ticket.reconnectToken, 'guest-token');
});

test('finished matches cannot recreate a cleared resume ticket through heartbeat', () => {
  let persisted = 0;
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    connected: true, syncing: false, _sessionTakenOver: false, _resumeDisabled: true,
    roomCode: 'ROOM01', reconnectToken: 'token',
    game: { state: { phase: 'gameEnd' } },
    _persistResumeTicket() { persisted++; },
  });
  multiplayer._heartbeatResumeTicket();
  assert.equal(persisted, 0);
});

test('a retained authority can recover the pre-snapshot round-one baseline', () => {
  let completed = 0;
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    active: true,
    syncing: true,
    connected: true,
    localId: 'host',
    hostId: 'host',
    isHost: true,
    _authorityEpoch: 2,
    _snapshotSeq: 0,
    _authoritySuspended: true,
    _resumeAuthorityOnMatchResume: false,
    roster: [],
    remotePlayers: [],
    _remoteById: new Map(),
    game: {
      player: {},
      events: { emit() {} },
      combat: { resumeNetworkAuthority() {} },
      bots: { resumeNetworkAuthority() {} },
    },
    _rebuildRemotes() {},
    _handleHostChanged: Multiplayer.prototype._handleHostChanged,
    _applySnapshotEnvelope() { return false; },
    _resumeAuthoritySimulation() { this._authoritySuspended = false; },
    _completeCanonicalSync() { completed++; this.syncing = false; },
  });

  multiplayer._onMessage({
    type: 'match_resume', matchId: 'match-1', mode: 'mixed', mapId: 'dustyard',
    players: [], hostId: 'host', authorityEpoch: 2, snapshotSeq: 0, snapshot: null,
  });
  assert.equal(completed, 1);
  assert.equal(multiplayer.syncing, false);
  assert.equal(multiplayer._authoritySuspended, false);
});

test('a replica waiting on an empty resume completes when the first canonical snapshot arrives', () => {
  const appliedLocal = [];
  let completed = 0;
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    syncing: true,
    localId: 'replica',
    hostId: 'host',
    isHost: false,
    _authorityEpoch: 2,
    _snapshotSeq: 0,
    _acceptAuthorityMetadata() { return true; },
    _applySnapshotEnvelope() { return true; },
    _applyLocalCanonicalState(snapshot, options) { appliedLocal.push({ snapshot, options }); },
    _completeCanonicalSync() { completed++; this.syncing = false; },
  });
  const snapshot = { players: [{ id: 'replica', state: { health: 100, alive: true } }] };

  multiplayer._onMessage({
    type: 'snapshot', hostId: 'host', authorityEpoch: 2, snapshotSeq: 1, snapshot,
  });
  assert.equal(completed, 1);
  assert.deepEqual(appliedLocal, [{
    snapshot,
    options: { includePose: true, includeLoadout: true, selfState: undefined },
  }]);
});

test('an equal-sequence canonical resume preserves remotes and force-replays the envelope', () => {
  const calls = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    active: true, syncing: true, localId: 'replica', hostId: 'host', isHost: false,
    matchId: 'match-1', mode: 'mixed', mapId: 'dustyard', roster: [],
    _snapshotSeq: 9, _resumeAuthorityOnMatchResume: false,
    game: { player: {}, hud: null },
    _hydrateRosterStats() {},
    _syncActiveRoster() { calls.push('sync-roster'); },
    _handleHostChanged(_message, options) { calls.push({ options }); return true; },
    _applyLocalCanonicalState() { calls.push('local'); },
    _completeCanonicalSync() { calls.push('complete'); this.syncing = false; },
  });
  multiplayer._onMessage({
    type: 'match_resume', matchId: 'match-1', mode: 'mixed', mapId: 'dustyard',
    players: [], hostId: 'host', authorityEpoch: 2, snapshotSeq: 9,
    snapshot: { state: { round: 2, phase: 'live' }, players: [] },
  });
  assert.equal(calls[0], 'sync-roster');
  assert.equal(calls[1].options.forceReplay, true);
  assert.deepEqual(calls.slice(2), ['local', 'complete']);
});

test('resume tickets are bounded while stale mobile tickets defer validity to the server', () => {
  const now = 50_000;
  const raw = JSON.stringify({
    roomCode: ' room01! ', reconnectToken: 'token-1', ownerId: 'tab-1',
    updatedAt: now - 100, expiresAt: now + 2_000,
  });
  assert.deepEqual(parseResumeTicket(raw, now), {
    roomCode: 'ROOM01', reconnectToken: 'token-1', ownerId: 'tab-1',
    ranked: true,
    updatedAt: now - 100, expiresAt: now + 2_000,
  });
  const expiredRaw = JSON.stringify({ ...JSON.parse(raw), expiresAt: now - 1 });
  assert.equal(parseResumeTicket(expiredRaw, now), null);
  assert.equal(parseResumeTicket(expiredRaw, now, { allowExpired: true })?.reconnectToken, 'token-1');

  const opened = [];
  const storage = { getItem(key) { return key === RESUME_TICKET_KEY ? expiredRaw : null; } };
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: { events: { emit() {} }, input: {}, combat: {} },
    socket: null,
    connected: false,
    localId: null,
    active: false,
    syncing: false,
    _resumeStorage: storage,
    _tabResumeStorage: null,
    _resumeOwnerId: 'tab-1',
    _resumeClaimTimer: null,
    _resumeSyncTimer: null,
    _ui: null,
    _setConnecting() {},
    _status() {},
    _persistResumeTicket() {},
    _openSocket(hello, reconnecting) { opened.push({ hello, reconnecting }); },
  });
  const realNow = Date.now;
  Date.now = () => now;
  try {
    assert.equal(multiplayer._restoreResumeTicket(), true);
  } finally {
    Date.now = realNow;
    clearTimeout(multiplayer._resumeSyncTimer);
  }
  assert.equal(multiplayer.syncing, true);
  assert.deepEqual(opened, [{
    hello: {
      type: 'hello', action: 'reconnect', room: 'ROOM01', reconnectToken: 'token-1', authorityProtocol: 1,
    },
    reconnecting: true,
  }]);
});

test('authority lifecycle yield is guarded, deduplicated, and DOM-optional', () => {
  const sent = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    active: true,
    connected: true,
    isHost: true,
    _authoritySuspended: false,
    _authorityEpoch: 8,
    _yieldedAuthorityEpoch: null,
    _localState() { return { alive: true, pos: { x: 1, y: 2, z: 3 } }; },
    _makeSnapshot() { return { state: { round: 3, phase: 'live' }, bots: [] }; },
    _send(message) { sent.push(message); },
  });

  assert.doesNotThrow(() => multiplayer._bindLifecycle());
  assert.equal(multiplayer._yieldAuthority(), true);
  assert.equal(multiplayer._yieldAuthority(), false);
  assert.deepEqual(sent, [
    { type: 'player_state', state: { alive: true, pos: { x: 1, y: 2, z: 3 } } },
    {
      type: 'snapshot',
      authorityEpoch: 8,
      snapshot: { state: { round: 3, phase: 'live' }, bots: [] },
    },
    { type: 'yield_authority', authorityEpoch: 8 },
  ]);
  multiplayer.isHost = false;
  multiplayer._yieldedAuthorityEpoch = null;
  assert.equal(multiplayer._yieldAuthority(), false);
});

test('browser offline immediately fences an apparently open authority socket', () => {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  const fakeWindow = {
    addEventListener(type, listener) { windowListeners.set(type, listener); },
  };
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  globalThis.document = fakeDocument;
  globalThis.window = fakeWindow;
  const closed = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    active: true, connected: true, syncing: false, isHost: true,
    socket: { close(code, reason) { closed.push([code, reason]); } },
    game: { events: { emit() {} }, input: {}, combat: { suspendNetworkAuthority() {} } },
    _ui: null,
  });
  try {
    multiplayer._bindLifecycle();
    windowListeners.get('offline')();
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  }
  assert.equal(multiplayer.syncing, true);
  assert.equal(multiplayer.isAuthority(), false);
  assert.deepEqual(closed, [[4000, 'browser offline']]);
});

test('a disconnected online host cannot continue authoritative simulation', () => {
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    active: true,
    connected: true,
    isHost: true,
    _authoritySuspended: false,
  });
  assert.equal(multiplayer.isAuthority(), true);
  multiplayer.connected = false;
  assert.equal(multiplayer.isAuthority(), false);
  multiplayer.connected = true;
  multiplayer._authoritySuspended = true;
  assert.equal(multiplayer.isAuthority(), false, 'an unhydrated reconnect stays suspended');
  multiplayer.active = false;
  assert.equal(multiplayer.isAuthority(), true, 'offline solo play remains locally authoritative');
});

test('a solo authority rehydrates its final frame when the server retains its lease', () => {
  const { multiplayer, applied, sent, resumed } = authorityClient('host');
  multiplayer.hostId = 'host';
  multiplayer.isHost = true;
  multiplayer._authoritySuspended = true;
  multiplayer._onMessage({
    type: 'authority_retained',
    hostId: 'host',
    authorityEpoch: 4,
    snapshotSeq: 21,
    serverTime: 110,
    snapshot: {
      state: { round: 6, phase: 'live', timer: 28 },
      bots: [{ name: 'Sarge', alive: true }],
      combat: { projectiles: [], smokes: [] },
    },
  });
  assert.equal(applied.length, 1);
  assert.equal(applied[0].wasAuthority, false);
  assert.deepEqual(resumed, ['bots', 'combat']);
  assert.equal(multiplayer._authoritySuspended, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'snapshot');
});

test('same-host reconnect replays canonical transient state before continuing authority', () => {
  const applied = [];
  const resumed = [];
  const sent = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: {
      events: { emit() {} },
      bots: { resumeNetworkAuthority() { resumed.push('bots'); } },
      combat: { resumeNetworkAuthority() { resumed.push('combat'); } },
    },
    active: true,
    connected: true,
    localId: 'host',
    hostId: 'host',
    isHost: true,
    matchId: 'match-1',
    mode: 'mixed',
    mapId: 'dustyard',
    roster: [],
    _authorityEpoch: 7,
    _snapshotSeq: 30,
    _serverTime: 100,
    _sendAccum: 0.2,
    _snapshotAccum: 0.2,
    _yieldedAuthorityEpoch: null,
    _setConnecting() {},
    _commitPendingProfile() {},
    _applyRoomMap() {},
    _syncActiveRoster() {},
    _hydrateRosterStats() {},
    _renderLobby() {},
    _applySnapshot(snapshot) {
      applied.push({ snapshot, wasAuthority: this.isHost });
      return true;
    },
    _makeSnapshot() { return { state: { round: 4, phase: 'live' }, bots: [] }; },
    _send(message) { sent.push(message); },
  });

  const reconnectEnvelope = {
    type: 'welcome',
    id: 'host',
    room: 'ROOM01',
    reconnectToken: 'resume-token',
    resumed: true,
    matchId: 'match-1',
    mode: 'mixed',
    mapId: 'dustyard',
    players: [],
    hostId: 'host',
    authorityEpoch: 7,
    snapshotSeq: 31,
    serverTime: 110,
    snapshot: null,
  };
  multiplayer._onMessage(reconnectEnvelope);

  multiplayer._onMessage({
    ...reconnectEnvelope,
    type: 'match_resume',
    snapshot: {
      state: { round: 4, phase: 'live', timer: 51 },
      bots: [{ name: 'Sarge', alive: true }],
      combat: { projectiles: [], smokes: [] },
    },
  });

  assert.equal(applied.length, 1, 'match-resume hydrates canonical state before authority continues');
  assert.ok(applied.every((entry) => entry.wasAuthority === false),
    'reconnect snapshots always apply through replica code');
  assert.deepEqual(resumed, ['bots', 'combat'], 'canonical transient state is made live again');
  assert.equal(multiplayer.isHost, true);
  assert.equal(multiplayer.hostId, 'host');
  assert.equal(multiplayer._snapshotSeq, 31);
  assert.equal(sent.length, 1, 'canonical reconnect emits exactly one fresh lease snapshot');
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[0].authorityEpoch, 7);
});

test('a promoted reconnecting replica waits for canonical handoff state before simulating', () => {
  const { multiplayer, applied, sent, resumed } = authorityClient('guest');
  multiplayer._authorityResumePending = false;
  multiplayer._resumeAuthorityOnMatchResume = false;
  multiplayer._setConnecting = () => {};
  multiplayer._commitPendingProfile = () => {};

  multiplayer._onMessage({
    type: 'welcome',
    id: 'guest',
    room: 'ROOM01',
    reconnectToken: 'guest-resume-token',
    resumed: true,
    mode: 'mixed',
    mapId: 'dustyard',
    hostId: 'guest',
    authorityEpoch: 5,
    snapshotSeq: 22,
    serverTime: 120,
    snapshot: null,
  });

  assert.equal(multiplayer.isHost, true, 'the lease metadata is visible immediately');
  assert.equal(multiplayer._authorityResumePending, true);
  assert.equal(applied.length, 0);
  assert.equal(sent.length, 0, 'promotion cannot publish local stale state before hydration');
  assert.deepEqual(resumed, []);

  multiplayer._onMessage({
    type: 'host_changed',
    hostId: 'guest',
    authorityEpoch: 5,
    snapshotSeq: 22,
    serverTime: 120,
    snapshot: {
      state: { round: 6, phase: 'live', timer: 29 },
      bots: [{ name: 'Sarge', alive: true }],
      combat: { projectiles: [], smokes: [] },
    },
  });

  assert.equal(applied.length, 1);
  assert.equal(applied[0].wasAuthority, false, 'handoff hydration uses replica code');
  assert.deepEqual(resumed, ['bots', 'combat']);
  assert.equal(multiplayer._authorityResumePending, false);
  assert.equal(sent.length, 1, 'the new authority publishes only after canonical hydration');
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[0].authorityEpoch, 5);
});

test('an inactive late join promoted into an abandoned room hydrates after startup before simulating', () => {
  const order = [];
  const applied = [];
  const sent = [];
  const multiplayer = Object.assign(Object.create(Multiplayer.prototype), {
    game: {
      events: { emit() {} },
      state: { round: 1 },
      player: {
        team: 'ct',
        name: 'Late',
        characterId: 'vanguard',
        waitForNextRound() {},
      },
      profile: { characterId: 'vanguard', update() {} },
      viewmodel: { applyProfileAppearance() {} },
      bots: {
        resumeNetworkAuthority() { order.push('resume-bots'); },
      },
      combat: {
        resumeNetworkAuthority() { order.push('resume-combat'); },
      },
      input: { requestLock() {} },
    },
    active: false,
    connected: true,
    localId: 'late',
    localName: 'Late',
    hostId: 'late',
    isHost: true,
    mapId: 'dustyard',
    mode: 'mixed',
    roster: [],
    waitingForNextRound: true,
    joinRound: 7,
    _pendingLiveJoin: true,
    _unrankedIdentityConflict: false,
    _authorityEpoch: 5,
    _snapshotSeq: 21,
    _serverTime: 110,
    _authorityResumePending: true,
    _yieldedAuthorityEpoch: null,
    _sendAccum: 0.4,
    _snapshotAccum: 0.7,
    _ui: { panel: { style: {} } },
    _applyRoomMap() {},
    _rebuildRemotes() {},
    _configureBots() {},
    _queueBotRosterRebalance() {},
    _applySnapshot(snapshot) {
      order.push('apply');
      applied.push({ snapshot, wasAuthority: this.isHost });
      return true;
    },
    _makeSnapshot() {
      order.push('make');
      return { state: { round: 6, phase: 'live' }, bots: [] };
    },
    _send(message) {
      order.push('send');
      sent.push(message);
    },
  });

  multiplayer._onMessage({
    type: 'match_resume',
    room: 'ROOM01',
    matchId: 'match-1',
    mapId: 'dustyard',
    mode: 'mixed',
    hostId: 'late',
    authorityEpoch: 5,
    snapshotSeq: 22,
    serverTime: 120,
    lateJoin: true,
    spectating: true,
    joinRound: 7,
    players: [{
      id: 'late', name: 'Late', team: 'ct', characterId: 'vanguard',
      spectating: true, joinRound: 7,
    }],
    snapshot: {
      state: { round: 6, phase: 'live', timer: 29 },
      bots: [{ name: 'Sarge', team: 'ct', alive: true }],
      combat: { projectiles: [], smokes: [] },
    },
  });

  assert.equal(multiplayer.active, true);
  assert.equal(multiplayer.isHost, true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].wasAuthority, false, 'startup completes before replica hydration');
  assert.equal(multiplayer._snapshotSeq, 22);
  assert.deepEqual(order, ['apply', 'resume-bots', 'resume-combat', 'make', 'send']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'snapshot');
  assert.equal(sent[0].authorityEpoch, 5);
});
