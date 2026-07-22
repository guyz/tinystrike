export const MAX_ROOM_PLAYERS = 10;
export const AUTHORITY_LEASE_MS = 1_500;
export const AUTHORITY_STARTUP_GRACE_MS = 5_000;

const MATCH_PHASES = new Set(['freeze', 'live', 'planted', 'roundEnd', 'gameEnd']);
const TIMED_PHASES = new Set(['freeze', 'live', 'planted', 'roundEnd']);
const ECONOMY = Object.freeze({
  START_MONEY: 8_000,
  MAX_MONEY: 16_000,
  WIN_REWARD: 3_250,
  LOSS_BASE: 1_400,
  LOSS_STEP: 500,
  LOSS_MAX: 3_400,
  DEFUSE_REWARD: 300,
});
const PLAYER_STATE_NUMBER_FIELDS = Object.freeze([
  'yaw',
  'pitch',
  'health',
  'armor',
  'moveSpeed2D',
]);
const PLAYER_STATE_BOOLEAN_FIELDS = Object.freeze([
  'hasKit',
  'alive',
  'crouching',
  'walking',
  'onGround',
  'useDown',
]);

function boundedWeaponId(value) {
  return typeof value === 'string' ? value.slice(0, 32) : null;
}

function sanitizeInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawSlots = value.slots && typeof value.slots === 'object' ? value.slots : {};
  const slots = {
    1: boundedWeaponId(rawSlots[1]),
    2: boundedWeaponId(rawSlots[2]),
    3: boundedWeaponId(rawSlots[3]),
    4: Array.isArray(rawSlots[4])
      ? rawSlots[4].slice(0, 8).map(boundedWeaponId).filter(Boolean)
      : [],
  };
  const ammo = {};
  if (value.ammo && typeof value.ammo === 'object' && !Array.isArray(value.ammo)) {
    for (const [id, counts] of Object.entries(value.ammo).slice(0, 16)) {
      const weaponId = boundedWeaponId(id);
      if (!weaponId || !counts || typeof counts !== 'object') continue;
      ammo[weaponId] = {
        mag: Math.max(0, Math.min(999, Math.floor(Number(counts.mag) || 0))),
        reserve: Math.max(0, Math.min(9999, Math.floor(Number(counts.reserve) || 0))),
      };
    }
  }
  return {
    slots,
    ammo,
    currentId: boundedWeaponId(value.currentId),
  };
}

export function roomPlayers(room) {
  if (room?.players instanceof Map) return [...room.players.values()];
  if (room?.players && typeof room.players === 'object') return Object.values(room.players);
  return [];
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function remainingAfterElapsed(value, elapsed) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number - elapsed) : 0;
}

/**
 * Keep the browser's frequent pose update bounded and protocol-shaped before
 * it enters room storage, broadcasts, or hibernation metadata. Unknown fields
 * are deliberately discarded rather than copied from an untrusted message.
 */
export function sanitizePlayerState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = {};
  const pos = value.pos;
  if (pos && typeof pos === 'object' && !Array.isArray(pos) &&
    Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
    state.pos = { x: pos.x, y: pos.y, z: pos.z };
  }
  for (const field of PLAYER_STATE_NUMBER_FIELDS) {
    if (Number.isFinite(value[field])) state[field] = value[field];
  }
  for (const field of PLAYER_STATE_BOOLEAN_FIELDS) {
    if (typeof value[field] === 'boolean') state[field] = value[field];
  }
  if (typeof value.weaponId === 'string') state.weaponId = value.weaponId.slice(0, 32);
  if (typeof value.characterId === 'string') state.characterId = value.characterId.slice(0, 32);
  if (Number.isFinite(value.money)) state.money = Math.max(0, Math.min(16_000, Math.floor(value.money)));
  if (Number.isFinite(value.economyRound)) {
    state.economyRound = Math.max(0, Math.floor(value.economyRound));
  }
  const inventory = sanitizeInventory(value.inventory);
  if (inventory) state.inventory = inventory;
  const round = Math.floor(Number(value.round));
  if (Number.isFinite(round) && round >= 0) state.round = round;
  return state;
}

/** Strip resume-only economy/loadout fields before replication to opponents. */
export function publicPlayerState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const {
    money: _money,
    inventory: _inventory,
    economyRound: _economyRound,
    lossStreak: _lossStreak,
    roundReset: _roundReset,
    ...state
  } = value;
  return state;
}

/** The room server returns this only to the player who owns the reconnect token. */
export function playerResumeState(player) {
  if (!player || !player.state || typeof player.state !== 'object') return null;
  return {
    ...player.state,
    alive: player.alive !== false,
    characterId: player.characterId || player.state.characterId,
    lossStreak: nonNegativeInteger(player.lossStreak),
  };
}

export function playerStateMatchesRoomRound(room, state, authorityProtocol = 0) {
  const currentRound = snapshotRound(room);
  if (currentRound === null) return true;
  const incomingRound = Number.isFinite(Number(state?.round)) ? Math.floor(Number(state.round)) : null;
  if (Number(authorityProtocol) >= 1) return incomingRound === currentRound;
  return incomingRound === null || incomingRound === currentRound;
}

/** Persist host-authoritative damage so reconnect snapshots cannot resurrect a player. */
export function applyAuthoritativeDamageResult(player, result) {
  if (!player || !result || typeof result !== 'object') return null;
  const state = player.state && typeof player.state === 'object' ? { ...player.state } : {};
  const alreadyDead = player.alive === false;
  if (!alreadyDead && Number.isFinite(result.health)) state.health = Math.max(0, result.health);
  if (!alreadyDead && Number.isFinite(result.armor)) state.armor = Math.max(0, result.armor);
  const healthAllowsAlive = !Number.isFinite(state.health) || state.health > 0;
  player.alive = !alreadyDead && result.alive !== false && healthAllowsAlive;
  if (!player.alive) state.health = 0;
  state.alive = player.alive;
  player.state = state;
  return state;
}

export function resetPlayerForRound(player, round = null) {
  if (!player || typeof player !== 'object') return null;
  const died = player.alive === false;
  const state = {
    ...(player.state && typeof player.state === 'object' ? player.state : {}),
    alive: true,
    health: 100,
    roundReset: died ? 'died' : 'survived',
  };
  for (const field of ['pos', 'yaw', 'pitch', 'crouching', 'walking', 'moveSpeed2D', 'onGround', 'useDown']) {
    delete state[field];
  }
  const canonicalRound = round === null || round === undefined ? NaN : Math.floor(Number(round));
  if (Number.isFinite(canonicalRound) && canonicalRound >= 0) state.round = canonicalRound;
  if (died) state.hasKit = false;
  player.alive = true;
  player.state = state;
  return player.state;
}

/**
 * Resolve the round to which a replicated `roundResult` belongs. The client
 * intentionally keeps its last result while the next round runs, so the
 * snapshot's current round is one ahead outside the roundEnd/gameEnd phases.
 */
export function completedRoundForResult(state) {
  const round = Math.floor(Number(state?.round));
  if (!Number.isFinite(round) || round < 1) return null;
  if (state?.phase === 'roundEnd' || state?.phase === 'gameEnd') return round;
  return round > 1 ? round - 1 : null;
}

/**
 * Advance disconnected players' money from the same authoritative round
 * result consumed by active clients. This makes a later resume independent of
 * whether that browser observed the short roundEnd phase.
 */
export function reconcileRoundEconomy(room, state) {
  if (!room || !state || typeof state !== 'object') return false;
  const result = state.roundResult && typeof state.roundResult === 'object' ? state.roundResult : null;
  const winner = result?.winner === 't' ? 't' : result?.winner === 'ct' ? 'ct' : null;
  const resultRound = completedRoundForResult(state);
  if (!winner || !resultRound) return false;
  if (!resultRound || nonNegativeInteger(room.lastEconomyRound) >= resultRound) return false;

  for (const player of roomPlayers(room)) {
    if (!player) continue;
    const playerState = player.state && typeof player.state === 'object' ? { ...player.state } : {};
    let money = Number.isFinite(playerState.money) ? playerState.money : ECONOMY.START_MONEY;
    const alreadyApplied = nonNegativeInteger(playerState.economyRound) >= resultRound;
    if (player.team === winner) {
      player.lossStreak = 0;
      if (!alreadyApplied) {
        money += ECONOMY.WIN_REWARD;
        if (result.reason === 'defuse' && result.defuserId && result.defuserId === player.id) {
          money += ECONOMY.DEFUSE_REWARD;
        }
      }
    } else {
      player.lossStreak = nonNegativeInteger(player.lossStreak) + 1;
      if (!alreadyApplied) {
        money += Math.min(
          ECONOMY.LOSS_BASE + ECONOMY.LOSS_STEP * (player.lossStreak - 1),
          ECONOMY.LOSS_MAX,
        );
      }
    }
    playerState.money = Math.max(0, Math.min(ECONOMY.MAX_MONEY, Math.floor(money)));
    playerState.economyRound = resultRound;
    player.state = playerState;
  }
  room.lastEconomyRound = resultRound;
  return true;
}

/**
 * Backfills authority metadata on rooms created by older deployments. The
 * authoritative lease is intentionally renewed only by accepted snapshots;
 * WebSocket ping/pong merely proves that the network stack is alive, not that
 * the browser simulation is still advancing.
 */
export function normalizeRoomAuthority(room, now = Date.now()) {
  if (!room || typeof room !== 'object') return room;
  room.authorityEpoch = nonNegativeInteger(room.authorityEpoch, 1) || 1;
  room.snapshotSeq = nonNegativeInteger(room.snapshotSeq);
  const fallback = Number(room.startedAt) || Number(now) || Date.now();
  if (!Number.isFinite(Number(room.authorityAssignedAt))) room.authorityAssignedAt = fallback;
  if (room.lastSnapshot && !Number.isFinite(Number(room.lastAuthoritySnapshotAt))) {
    // Existing rooms receive a fresh lease during a rolling deployment rather
    // than being migrated immediately from an unknown timestamp.
    room.lastAuthoritySnapshotAt = Number(now) || Date.now();
  }
  return room;
}

export function authorityLeaseExpired(
  room,
  now = Date.now(),
  leaseMs = AUTHORITY_LEASE_MS,
  startupGraceMs = AUTHORITY_STARTUP_GRACE_MS,
) {
  if (!room?.started || roomPhase(room) === 'gameEnd') return false;
  normalizeRoomAuthority(room, now);
  const hasSnapshot = !!room.lastSnapshot && Number.isFinite(Number(room.lastAuthoritySnapshotAt));
  const renewedAt = hasSnapshot
    ? Number(room.lastAuthoritySnapshotAt)
    : Number(room.authorityAssignedAt);
  const timeout = hasSnapshot ? Number(leaseMs) : Number(startupGraceMs);
  return Number(now) - renewedAt >= Math.max(250, Number.isFinite(timeout) ? timeout : AUTHORITY_LEASE_MS);
}

export function canonicalSnapshot(room, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const players = roomPlayers(room)
    .filter((player) => player && player.id && player.state && typeof player.state === 'object')
    .map((player) => ({
      id: player.id,
      state: publicPlayerState({
        ...player.state,
        alive: player.alive !== false,
        characterId: player.characterId || player.state.characterId,
      }),
    }));
  return { ...snapshot, players };
}

export function acceptAuthoritySnapshot(room, snapshot, now = Date.now()) {
  if (!room) return null;
  normalizeRoomAuthority(room, now);
  const accepted = canonicalSnapshot(room, snapshot);
  if (!accepted) return null;
  room.lastSnapshot = accepted;
  room.lastAuthoritySnapshotAt = Number(now) || Date.now();
  room.snapshotSeq = nonNegativeInteger(room.snapshotSeq) + 1;
  return authoritySnapshotEnvelope(room);
}

/** Advance only the wall-clock portion of a handoff snapshot. */
export function snapshotForAuthorityHandoff(room, now = Date.now()) {
  const snapshot = canonicalSnapshot(room, room?.lastSnapshot);
  if (!snapshot || typeof snapshot !== 'object') return null;
  const state = snapshot.state && typeof snapshot.state === 'object'
    ? { ...snapshot.state }
    : null;
  const acceptedAt = Number(room.lastAuthoritySnapshotAt);
  const elapsed = Number.isFinite(acceptedAt) ? Math.max(0, (Number(now) - acceptedAt) / 1000) : 0;
  if (state && TIMED_PHASES.has(state.phase) && Number.isFinite(Number(state.timer))) {
    state.timer = Math.max(0, Number(state.timer) - elapsed);
  }
  const combat = snapshot.combat && typeof snapshot.combat === 'object'
    ? {
        ...snapshot.combat,
        projectiles: Array.isArray(snapshot.combat.projectiles)
          ? snapshot.combat.projectiles.map((projectile) => ({
              ...projectile,
              fuse: remainingAfterElapsed(projectile?.fuse, elapsed),
            }))
          : [],
        smokes: Array.isArray(snapshot.combat.smokes)
          ? snapshot.combat.smokes.map((smoke) => ({
              ...smoke,
              remaining: remainingAfterElapsed(smoke?.remaining, elapsed),
            })).filter((smoke) => smoke.remaining > 0)
          : [],
      }
    : null;
  return {
    ...snapshot,
    ...(state ? { state } : {}),
    ...(combat ? { combat } : {}),
  };
}

export function authoritySnapshotEnvelope(room, snapshot = room?.lastSnapshot) {
  normalizeRoomAuthority(room);
  const canonical = snapshot ? canonicalSnapshot(room, snapshot) : null;
  return {
    hostId: room?.hostId || null,
    authorityEpoch: nonNegativeInteger(room?.authorityEpoch, 1) || 1,
    snapshotSeq: nonNegativeInteger(room?.snapshotSeq),
    serverTime: Number(room?.lastAuthoritySnapshotAt) || Date.now(),
    snapshot: canonical,
  };
}

/**
 * Atomically changes the browser that owns simulation authority. Membership is
 * deliberately untouched so a disconnected player's reserved seat can still
 * reconnect without reclaiming authority.
 */
export function transferRoomAuthority(room, nextHostId, now = Date.now(), reason = 'handoff') {
  if (!room || !nextHostId || nextHostId === room.hostId) return null;
  normalizeRoomAuthority(room, now);
  const snapshot = snapshotForAuthorityHandoff(room, now);
  room.hostId = nextHostId;
  room.authorityEpoch = nonNegativeInteger(room.authorityEpoch, 1) + 1;
  room.authorityAssignedAt = Number(now) || Date.now();
  if (snapshot) {
    room.lastSnapshot = snapshot;
    room.lastAuthoritySnapshotAt = Number(now) || Date.now();
    room.snapshotSeq = nonNegativeInteger(room.snapshotSeq) + 1;
  }
  return {
    type: 'host_changed',
    reason,
    ...authoritySnapshotEnvelope(room),
  };
}

export function snapshotRound(room) {
  const snapshotValue = Number(room?.lastSnapshot?.state?.round);
  if (Number.isFinite(snapshotValue) && snapshotValue >= 0) return Math.floor(snapshotValue);
  const trackedValue = Number(room?.currentRound);
  return Number.isFinite(trackedValue) && trackedValue >= 0 ? Math.floor(trackedValue) : null;
}

export function roomPhase(room) {
  if (!room?.started) return 'waiting';
  const phase = String(room?.lastSnapshot?.state?.phase || 'starting');
  return MATCH_PHASES.has(phase) ? phase : 'starting';
}

export function nextJoinRound(room) {
  const current = snapshotRound(room);
  if (current !== null) return current + 1;
  return room?.started ? 2 : 1;
}

export function isWaitingForRound(player) {
  return Number.isFinite(Number(player?.joinRound)) && Number(player.joinRound) > 0;
}

export function releasePlayersForRound(room, state) {
  const round = Number(state?.round);
  if (!Number.isFinite(round) || round < 1 || state?.phase === 'gameEnd') return [];
  const normalizedRound = Math.floor(round);
  const released = [];
  for (const player of roomPlayers(room)) {
    if (!isWaitingForRound(player) || normalizedRound < Number(player.joinRound)) continue;
    player.joinRound = null;
    resetPlayerForRound(player, normalizedRound);
    released.push(player);
  }
  return released;
}

export function publicRoomSummary(room, maxPlayers = MAX_ROOM_PLAYERS) {
  const entries = roomPlayers(room);
  const players = entries.filter((player) => player?.connected !== false).length;
  const reservedPlayers = entries.length;
  const phase = roomPhase(room);
  const currentRound = snapshotRound(room);
  const capacity = Math.max(1, Math.floor(Number(maxPlayers) || MAX_ROOM_PLAYERS));
  return {
    code: String(room?.code || ''),
    room: String(room?.code || ''),
    mapId: String(room?.mapId || 'dustyard'),
    mode: room?.mode === 'humans' ? 'humans' : 'mixed',
    started: !!room?.started,
    phase,
    joinable: players > 0 && reservedPlayers < capacity && phase !== 'gameEnd',
    players,
    maxPlayers: capacity,
    reservedPlayers,
    currentRound,
  };
}
