import { mapById, normalizeMapId } from '../maps/catalog.js';
import { resolveRoomDirectoryEndpoint } from './endpoints.js';

const DEFAULT_CAPACITY = 10;
const FINISHED_PHASES = new Set(['ended', 'finished', 'gameend', 'game_end']);

function finiteCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function cleanCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/**
 * Convert the room service's deliberately small public projection into the
 * stable shape consumed by the menu. Alias support keeps local/older servers
 * useful while the production protocol rolls forward.
 */
export function normalizeRoomEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const code = cleanCode(value.code ?? value.room ?? value.roomCode);
  if (!code) return null;

  const rawPlayers = value.players;
  const players = finiteCount(
    Array.isArray(rawPlayers)
      ? rawPlayers.length
      : (rawPlayers ?? value.playerCount ?? value.currentPlayers),
  );
  const maxPlayers = Math.max(1, finiteCount(
    value.maxPlayers ?? value.capacity ?? value.max,
    DEFAULT_CAPACITY,
  ));
  const phase = String(value.phase || value.status || (value.started ? 'live' : 'lobby')).toLowerCase();
  const started = value.started === true || !['lobby', 'waiting', 'open'].includes(phase);
  const finished = FINISHED_PHASES.has(phase);
  const joinable = value.joinable !== false && !finished && players < maxPlayers;
  const currentRound = finiteCount(value.currentRound ?? value.round, 0);

  return {
    code,
    mapId: normalizeMapId(value.mapId ?? value.map),
    mode: value.mode === 'humans' ? 'humans' : 'mixed',
    phase,
    started,
    finished,
    joinable,
    players,
    maxPlayers,
    reservedPlayers: finiteCount(value.reservedPlayers),
    currentRound,
  };
}

export function normalizeRoomDirectory(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : payload && (payload.rooms ?? payload.data ?? payload.entries);
  if (!Array.isArray(rows)) return [];
  return rows
    .map(normalizeRoomEntry)
    .filter(Boolean)
    .sort((left, right) => {
      if (left.joinable !== right.joinable) return left.joinable ? -1 : 1;
      if (left.started !== right.started) return left.started ? 1 : -1;
      if (left.players !== right.players) return right.players - left.players;
      return left.code.localeCompare(right.code);
    });
}

export function roomStatus(room) {
  if (!room) return { label: 'UNKNOWN', detail: '' };
  if (room.finished) return { label: 'FINISHED', detail: 'MATCH ENDED' };
  if (!room.joinable) return { label: 'FULL', detail: 'ROOM FULL' };
  if (!room.started) return { label: 'LOBBY', detail: 'JOIN NOW' };
  return {
    label: room.currentRound > 0 ? `ROUND ${room.currentRound}` : 'IN MATCH',
    detail: 'JOIN TO SPECTATE',
  };
}

export async function fetchRoomDirectory(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error('Room discovery is unavailable in this browser.');
  const endpoint = options.endpoint || resolveRoomDirectoryEndpoint();
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: options.signal,
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Could not load live rooms.');
  }
  return {
    rooms: normalizeRoomDirectory(payload),
    updatedAt: payload?.updatedAt || null,
  };
}

export function roomPresentation(room) {
  const map = mapById(room?.mapId);
  return {
    map,
    status: roomStatus(room),
    modeLabel: room?.mode === 'humans' ? 'HUMANS ONLY' : 'HUMANS + BOTS',
  };
}
