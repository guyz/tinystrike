export const MAX_ROOM_PLAYERS = 10;

const MATCH_PHASES = new Set(['freeze', 'live', 'planted', 'roundEnd', 'gameEnd']);

export function roomPlayers(room) {
  if (room?.players instanceof Map) return [...room.players.values()];
  if (room?.players && typeof room.players === 'object') return Object.values(room.players);
  return [];
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
    player.alive = true;
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
