import * as THREE from 'three';
import { mapById, normalizeMapId } from '../maps/catalog.js';
import {
  getCharacterPalette,
  normalizeCharacterId,
  normalizePlayerName,
} from '../player/profile.js';
import { resolveWebSocketEndpoint } from './endpoints.js';
import {
  fetchRoomDirectory,
  roomPresentation,
} from './room-directory.js';

const SEND_HZ = 20;
const SNAPSHOT_HZ = 12;
const TEAM_SIZE = 5;
const MAX_RECONNECT_ATTEMPTS = 10;
const ROOM_REFRESH_MS = 8_000;
const RESUME_SYNC_TIMEOUT_MS = 2_000;
const RESUME_TICKET_TTL_MS = 115_000;
const RESUME_OWNER_STALE_MS = 4_000;
const RECOVERY_RETRY_MS = 10_000;
export const RESUME_TICKET_KEY = 'tiny-strike-room-resume-v1';
const RESUME_OWNER_KEY = 'tiny-strike-tab-owner-v1';
const RESUME_SEAT_PREFIX = 'tiny-strike-room-seat-v1:';
const RANKED_IDENTITY_IN_USE = 'ranked_identity_in_use';
const EFFECT_EVENTS = [
  'fx:tracer', 'fx:impact', 'fx:blood', 'fx:explosion', 'fx:flash', 'fx:smoke', 'kill',
];
const AUTHORITY_OUTBOUND_TYPES = new Set(['snapshot', 'damage', 'event', 'yield_authority']);
const SYNC_BLOCKED_OUTBOUND_TYPES = new Set([
  'player_state', 'snapshot', 'damage', 'event', 'fire', 'grenade',
]);
const AUTHORITY_PROTOCOL_VERSION = 1;

function storageOf(name) {
  try {
    const storage = globalThis[name];
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : null;
  } catch {
    return null;
  }
}

function randomOwnerId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // Fall through to a bounded non-cryptographic tab identifier.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parseResumeTicket(raw, now = Date.now(), options = {}) {
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const roomCode = String(value.roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const reconnectToken = String(value.reconnectToken || '').slice(0, 256);
  const expiresAt = Number(value.expiresAt);
  if (!roomCode || !reconnectToken || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= Number(now) && !options.allowExpired) return null;
  return {
    roomCode,
    reconnectToken,
    ownerId: String(value.ownerId || '').slice(0, 80),
    ranked: value.ranked !== false,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
    expiresAt,
  };
}

export function shouldReuseResumeOwner(navigationType) {
  return navigationType === 'reload' || navigationType === 'back_forward';
}

function safeName(value) {
  return normalizePlayerName(value);
}

function vec(value) {
  if (!value) return null;
  return { x: Number(value.x) || 0, y: Number(value.y) || 0, z: Number(value.z) || 0 };
}

function serializable(value, depth = 0) {
  if (depth > 5 || value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value.isVector3 || (Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z))) {
    return vec(value);
  }
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => serializable(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === 'mesh' || key === 'game' || key.startsWith('_')) continue;
      const v = value[key];
      if (typeof v !== 'function') out[key] = serializable(v, depth + 1);
    }
    return out;
  }
  return null;
}

function angleLerp(from, to, amount) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * amount;
}

function positiveRound(value) {
  const round = Math.floor(Number(value));
  return Number.isFinite(round) && round > 0 ? round : null;
}

function protocolCounter(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

export function unrankedRetryHello(message, hello) {
  if (!hello?.leaderboardToken || message?.type !== 'error') return null;
  const rankedIdentityInUse = message.code === RANKED_IDENTITY_IN_USE ||
    /ranked identity is already playing/i.test(String(message.message || ''));
  return rankedIdentityInUse ? { ...hello, leaderboardToken: '' } : null;
}

export function botCountsForRoster(roster, mode, round = Infinity) {
  if (mode !== 'mixed') return { ct: 0, t: 0 };
  const counts = { ct: 0, t: 0 };
  for (const entry of Array.isArray(roster) ? roster : []) {
    if (!entry || (entry.team !== 'ct' && entry.team !== 't')) continue;
    const joinRound = positiveRound(entry.joinRound);
    if (joinRound && joinRound > round) continue;
    counts[entry.team]++;
  }
  return {
    ct: Math.max(0, TEAM_SIZE - counts.ct),
    t: Math.max(0, TEAM_SIZE - counts.t),
  };
}

export function botCountsForSnapshot(snapshot) {
  const counts = { ct: 0, t: 0 };
  const bots = snapshot && Array.isArray(snapshot.bots) ? snapshot.bots : [];
  for (const bot of bots) {
    if (bot && (bot.team === 'ct' || bot.team === 't')) counts[bot.team]++;
  }
  return counts;
}

export default class Multiplayer {
  constructor(game) {
    this.game = game;
    this.socket = null;
    this.connected = false;
    this.active = false;
    this.isHost = false;
    this.localId = null;
    this.localName = game.profile?.name || 'Operative';
    this.hostId = null;
    this.roomCode = '';
    this.matchId = null;
    this.mapId = normalizeMapId(game && game.selectedMapId);
    this.mode = 'mixed';
    this.roster = [];
    this.remotePlayers = [];
    this._remoteById = new Map();
    this._sendAccum = 0;
    this._snapshotAccum = 0;
    this._authorityEpoch = -1;
    this._snapshotSeq = -1;
    this._serverTime = 0;
    this._yieldedAuthorityEpoch = null;
    this._authorityResumePending = false;
    this._resumeAuthorityOnMatchResume = false;
    this._authoritySuspended = false;
    this._networkEvent = false;
    this.reconnectToken = '';
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._reconnecting = false;
    this.syncing = false;
    this._resumeSyncTimer = null;
    this._resumeClaimTimer = null;
    this._lifecycleSuspended = false;
    this._sessionTakenOver = false;
    this._resumeDisabled = false;
    this._localReconnectSockets = new WeakSet();
    this._pendingCanonicalSelfState = null;
    this._resumeStorage = storageOf('localStorage');
    this._resumeOwnerStorage = storageOf('sessionStorage');
    this._tabResumeStorage = this._resumeOwnerStorage;
    this._resumeOwnerId = this._loadResumeOwnerId();
    this._canPersistResumeTicket = true;
    this.waitingForNextRound = false;
    this.joinRound = null;
    this._pendingLiveJoin = false;
    this._botRosterPendingRound = null;
    this._connecting = false;
    this._roomDirectoryRequest = 0;
    this._roomDirectoryController = null;
    this._roomRefreshTimer = null;
    this._joiningUnranked = false;
    this._unrankedIdentityConflict = false;
    this._seatRanked = true;
    this._pendingProfile = null;
    this._leaderboardResultsSeen = new Set();
    this._buildUI();
    this._bindEvents();
    this._bindLifecycle();
    this.refreshRooms();
    this._roomRefreshTimer = setInterval(() => this._refreshRoomsIfVisible(), ROOM_REFRESH_MS);
    this._roomRefreshTimer?.unref?.();
    this._resumeHeartbeatTimer = setInterval(() => this._heartbeatResumeTicket(), 2_000);
    this._resumeHeartbeatTimer?.unref?.();
    this._restoreResumeTicket();
  }

  isAuthority() {
    return !this.active || (this.connected && this.isHost && !this.syncing && !this._authoritySuspended);
  }

  humans(team = null, includeLocal = true) {
    const result = [];
    const p = this.game.player;
    if (includeLocal && p && (!team || p.team === team)) result.push(p);
    for (const remote of this.remotePlayers) {
      if (!team || remote.team === team) result.push(remote);
    }
    return result;
  }

  aliveOf(team) {
    let count = 0;
    for (const human of this.humans(team)) if (human.alive) count++;
    return count;
  }

  localTeamIndex() {
    const sameTeam = this.roster.filter((p) => p.team === this.game.player.team);
    return Math.max(0, sameTeam.findIndex((p) => p.id === this.localId));
  }

  update(dt) {
    this._updateRemoteBodies(dt);
    if (this.syncing || !this.active || !this.connected || !this.socket ||
      this.socket.readyState !== WebSocket.OPEN) return;

    this._sendAccum += dt;
    if (this._sendAccum >= 1 / SEND_HZ) {
      this._sendAccum %= 1 / SEND_HZ;
      this._send({ type: 'player_state', state: this._localState() });
    }

    if (this.isAuthority()) {
      this._snapshotAccum += dt;
      if (this._snapshotAccum >= 1 / SNAPSHOT_HZ) {
        this._snapshotAccum %= 1 / SNAPSHOT_HZ;
        this._send({ type: 'snapshot', snapshot: this._makeSnapshot() });
      }
    }
  }

  async connect(action, discoveredRoom = '') {
    if (!this._ui || this._connecting || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    if (discoveredRoom) this._ui.room.value = String(discoveredRoom).toUpperCase();
    const name = safeName(this._ui.name.value);
    const characterId = normalizeCharacterId(this.game.profile?.characterId);
    const room = this._ui.room.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const mode = this._ui.mode.value === 'humans' ? 'humans' : 'mixed';
    if (action === 'join' && !room) {
      this._status('Enter a room code to join.', true);
      return;
    }
    this._setConnecting(true);
    this._joiningUnranked = false;
    this._unrankedIdentityConflict = false;
    this._seatRanked = false;
    this.localName = name;
    // The ranked token is shared by tabs on this origin. Do not persist the
    // room input until the server confirms that this window owns the ranked
    // seat; a duplicate tab may need to retry as an unranked guest.
    this._pendingProfile = { name, characterId };
    this._status('Securing ranked identity…');

    let leaderboardToken = '';
    if (this.game.leaderboard && typeof this.game.leaderboard.ensureSession === 'function') {
      try {
        leaderboardToken = await this.game.leaderboard.ensureSession({ refresh: true });
      } catch {
        this._status('Leaderboard offline — joining without rank sync.');
      }
    }
    this._status('Connecting…');

    this._openSocket({
      type: 'hello',
      action,
      name,
      characterId,
      room,
      mode,
      mapId: normalizeMapId(this.game.selectedMapId || this.mapId),
      leaderboardToken,
      authorityProtocol: AUTHORITY_PROTOCOL_VERSION,
    });
  }

  _openSocket(hello, reconnecting = false) {
    let endpoint;
    try {
      endpoint = resolveWebSocketEndpoint();
    } catch (error) {
      this._status(error.message || 'Online service configuration is invalid.', true);
      this._setConnecting(false);
      return;
    }

    let socket;
    try {
      socket = new WebSocket(endpoint);
    } catch {
      if (reconnecting) this._scheduleReconnect();
      else this._status('Could not reach the online service.', true);
      this._setConnecting(false);
      return;
    }
    this.socket = socket;
    this._reconnecting = reconnecting;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.connected = true;
      this._send(hello);
      if (reconnecting && this.syncing) this._armResumeSyncTimeout();
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const retryHello = reconnecting ? null : unrankedRetryHello(message, hello);
      if (retryHello) {
        this._joiningUnranked = true;
        this._status('Ranked profile already active here — joining this window as an unranked guest…');
        this.connected = false;
        this.socket = null;
        socket.close();
        this._openSocket(retryHello);
        return;
      }
      this._onMessage(message);
    });
    socket.addEventListener('close', (event) => this._onSocketClose(socket, event));
    socket.addEventListener('error', () => {
      if (!reconnecting) this._status('Could not reach the online service.', true);
      if (!reconnecting) this._setConnecting(false);
    });
  }

  _onSocketClose(socket, event = {}) {
    if (this.socket !== socket) return false;
    const localReplacement = this._localReconnectSockets.has(socket);
    this._localReconnectSockets.delete(socket);
    this.connected = false;
    this.socket = null;
    this._authoritySuspended = true;
    if (this.active && this.isHost && this.game.combat &&
      typeof this.game.combat.suspendNetworkAuthority === 'function') {
      this.game.combat.suspendNetworkAuthority();
    }
    this._setConnecting(false);
    if (Number(event?.code) === 4001 && !localReplacement) {
      this._sessionTakenOver = true;
      this._startCanonicalSync(
        'MATCH ACTIVE IN ANOTHER TAB',
        'This seat was resumed elsewhere. It will stay here safely paused unless that tab closes.',
      );
      this._status('This match is active in another tab.');
      this._scheduleResumeOwnershipCheck('takeover');
      return true;
    }
    if (this.active || this.syncing) {
      this._startCanonicalSync('RECONNECTING', 'Connection interrupted. Recovering the latest match state…');
    }
    if (this.localId && this.roomCode && this.reconnectToken) this._scheduleReconnect();
    else this._showDisconnected();
    return true;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this.socket) return;
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._showDisconnected();
      if (this.active) this.game.events.emit('hud:notice', { text: 'Still offline — recovery will retry when the connection returns.' });
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._scheduleReconnect();
      }, RECOVERY_RETRY_MS);
      this._reconnectTimer?.unref?.();
      return;
    }
    const delay = Math.min(5_000, 500 * (2 ** this._reconnectAttempts));
    this._reconnectAttempts++;
    this._reconnecting = true;
    this._status(`Connection interrupted — reconnecting (${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
    if (this.active && this._reconnectAttempts === 1) {
      this.game.events.emit('hud:notice', { text: 'Connection interrupted — reconnecting…' });
    }
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.socket || !this.roomCode || !this.reconnectToken) return;
      this._openSocket({
        type: 'hello',
        action: 'reconnect',
        room: this.roomCode,
        reconnectToken: this.reconnectToken,
        authorityProtocol: AUTHORITY_PROTOCOL_VERSION,
      }, true);
    }, delay);
    this._reconnectTimer?.unref?.();
  }

  _showDisconnected() {
    this._status('Disconnected from the room server.', true);
    if (this.active || this.syncing) {
      this._startCanonicalSync('CONNECTION LOST', 'Waiting for the room server. Gameplay is paused until state is restored.');
      return;
    }
    if (!this.active && this._ui) {
      this._ui.connect.style.display = 'block';
      this._ui.lobby.style.display = 'none';
      const solo = this.game.hudRoot.querySelector('#hud-start');
      if (solo) solo.style.display = 'block';
      this.localId = null;
      this.reconnectToken = '';
    }
  }

  _loadResumeOwnerId() {
    const storage = this._resumeOwnerStorage;
    let id = '';
    try { id = String(storage?.getItem(RESUME_OWNER_KEY) || ''); } catch { id = ''; }
    let navigationType = '';
    try {
      navigationType = String(globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type || '');
    } catch { navigationType = ''; }
    // A true reload/back-forward restoration keeps its seat owner. A newly
    // navigated or duplicated tab receives a new owner even if the browser
    // copied sessionStorage into it.
    if (id && (!navigationType || shouldReuseResumeOwner(navigationType))) return id;
    id = randomOwnerId();
    try { storage?.setItem(RESUME_OWNER_KEY, id); } catch { /* storage can be blocked */ }
    return id;
  }

  _resumeSeatTickets(options = {}) {
    const storage = this._resumeStorage;
    if (!storage) return [];
    const tickets = [];
    const seen = new Set();
    const add = (ticket) => {
      if (!ticket) return;
      const key = `${ticket.ownerId}:${ticket.reconnectToken}`;
      if (seen.has(key)) return;
      seen.add(key);
      tickets.push(ticket);
    };
    try { add(parseResumeTicket(storage.getItem(RESUME_TICKET_KEY), Date.now(), options)); } catch { /* v1 migration */ }
    let length = 0;
    try { length = Math.min(64, Math.max(0, Number(storage.length) || 0)); } catch { length = 0; }
    for (let index = 0; index < length; index++) {
      let key = '';
      try { key = String(storage.key(index) || ''); } catch { continue; }
      if (!key.startsWith(RESUME_SEAT_PREFIX)) continue;
      let ticket = null;
      try { ticket = parseResumeTicket(storage.getItem(key), Date.now(), options); } catch { /* ignore */ }
      if (ticket) add(ticket);
      else {
        try { storage.removeItem(key); } catch { /* expired cleanup is best effort */ }
      }
    }
    return tickets.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  _readResumeTicket() {
    try {
      // A hidden mobile tab can be discarded long after its last visible
      // heartbeat. The room server starts its grace period when the socket
      // actually disconnects, so an old local timestamp must not veto a still
      // valid server seat. Attempt it once and let the server validate it.
      const options = { allowExpired: true };
      return parseResumeTicket(this._tabResumeStorage?.getItem(RESUME_TICKET_KEY), Date.now(), options) ||
        this._resumeSeatTickets(options)[0] || null;
    } catch {
      return null;
    }
  }

  _persistResumeTicket() {
    if (this._resumeDisabled || !this.roomCode || !this.reconnectToken) return false;
    const now = Date.now();
    const ticket = {
      roomCode: this.roomCode,
      reconnectToken: this.reconnectToken,
      ownerId: this._resumeOwnerId,
      ranked: this._canPersistResumeTicket !== false,
      updatedAt: now,
      expiresAt: now + RESUME_TICKET_TTL_MS,
    };
    const encoded = JSON.stringify(ticket);
    let persisted = false;
    if (this._tabResumeStorage) {
      try { this._tabResumeStorage.setItem(RESUME_TICKET_KEY, encoded); persisted = true; } catch { /* ignore */ }
    }
    if (this._resumeStorage) {
      try {
        this._resumeStorage.setItem(`${RESUME_SEAT_PREFIX}${this._resumeOwnerId}`, encoded);
        this._resumeStorage.removeItem(RESUME_TICKET_KEY);
        persisted = true;
      } catch { /* ignore */ }
    }
    return persisted;
  }

  _clearResumeTicket(options = {}) {
    try { this._tabResumeStorage?.removeItem(RESUME_TICKET_KEY); } catch { /* ignore */ }
    if (!this._resumeStorage) return;
    try { this._resumeStorage.removeItem(`${RESUME_SEAT_PREFIX}${this._resumeOwnerId}`); } catch { /* ignore */ }
    try { this._resumeStorage.removeItem(RESUME_TICKET_KEY); } catch { /* ignore */ }
    if (!options.allMatching || !this.reconnectToken) return;
    let length = 0;
    try { length = Math.min(64, Math.max(0, Number(this._resumeStorage.length) || 0)); } catch { length = 0; }
    const remove = [];
    for (let index = 0; index < length; index++) {
      let key = '';
      try { key = String(this._resumeStorage.key(index) || ''); } catch { continue; }
      if (!key.startsWith(RESUME_SEAT_PREFIX)) continue;
      let ticket = null;
      try {
        ticket = parseResumeTicket(this._resumeStorage.getItem(key), Date.now(), { allowExpired: true });
      } catch { /* ignore */ }
      if (ticket?.reconnectToken === this.reconnectToken) remove.push(key);
    }
    for (const key of remove) {
      try { this._resumeStorage.removeItem(key); } catch { /* ignore */ }
    }
  }

  _heartbeatResumeTicket() {
    const visible = typeof document !== 'object' || !document || document.visibilityState !== 'hidden';
    const matchEnded = this.game?.state?.phase === 'gameEnd';
    if (visible && this.connected && !this.syncing && !this._sessionTakenOver && !this._resumeDisabled &&
      !matchEnded && this.roomCode && this.reconnectToken) {
      this._persistResumeTicket();
    }
  }

  _freshForeignResumeTicket(token = this.reconnectToken) {
    const now = Date.now();
    return this._resumeSeatTickets().find((ticket) =>
      ticket.ownerId && ticket.ownerId !== this._resumeOwnerId &&
      (!token || ticket.reconnectToken === token) &&
      now - ticket.updatedAt < RESUME_OWNER_STALE_MS
    ) || null;
  }

  _scheduleResumeOwnershipCheck(reason = 'foreground') {
    const ticket = this._freshForeignResumeTicket();
    if (!ticket) return false;
    if (this._resumeClaimTimer) clearTimeout(this._resumeClaimTimer);
    const delay = Math.max(250, RESUME_OWNER_STALE_MS - Math.max(0, Date.now() - ticket.updatedAt) + 100);
    this._resumeClaimTimer = setTimeout(() => {
      this._resumeClaimTimer = null;
      const visible = typeof document !== 'object' || !document || document.visibilityState !== 'hidden';
      if (visible) this._requestCanonicalSync(reason);
    }, delay);
    this._resumeClaimTimer?.unref?.();
    return true;
  }

  _restoreResumeTicket() {
    if (this.socket || this.connected || this.localId) return false;
    const ticket = this._readResumeTicket();
    if (!ticket) return false;
    const age = Math.max(0, Date.now() - ticket.updatedAt);
    if (ticket.ownerId && ticket.ownerId !== this._resumeOwnerId && age < RESUME_OWNER_STALE_MS) {
      if (this._resumeClaimTimer) clearTimeout(this._resumeClaimTimer);
      this._resumeClaimTimer = setTimeout(() => {
        this._resumeClaimTimer = null;
        this._restoreResumeTicket();
      }, Math.max(250, RESUME_OWNER_STALE_MS - age + 100));
      this._resumeClaimTimer?.unref?.();
      this._status('An existing match is active in another tab. Waiting to recover it if that tab closes.');
      return false;
    }

    this.roomCode = ticket.roomCode;
    this.reconnectToken = ticket.reconnectToken;
    this._canPersistResumeTicket = ticket.ranked !== false;
    this._seatRanked = ticket.ranked !== false;
    this._resumeDisabled = false;
    this._sessionTakenOver = false;
    this._reconnectAttempts = 0;
    this._startCanonicalSync('RESTORING YOUR MATCH', 'Loading the latest server state…');
    this._setConnecting(true);
    this._status('Recovering your previous room…');
    this._persistResumeTicket();
    this._openSocket({
      type: 'hello',
      action: 'reconnect',
      room: this.roomCode,
      reconnectToken: this.reconnectToken,
      authorityProtocol: AUTHORITY_PROTOCOL_VERSION,
    }, true);
    this._armResumeSyncTimeout();
    return true;
  }

  _startCanonicalSync(title = 'RECONNECTING', detail = 'Synchronizing the latest match state…') {
    const first = !this.syncing;
    this.syncing = true;
    this._authoritySuspended = true;
    this.game?.input?.releaseVirtualControls?.();
    this.game?.combat?.suspendNetworkAuthority?.();
    if (this._ui?.syncOverlay) {
      this._ui.syncOverlay.style.display = 'flex';
      if (this._ui.syncTitle) this._ui.syncTitle.textContent = title;
      if (this._ui.syncDetail) this._ui.syncDetail.textContent = detail;
    }
    if (first) this.game?.events?.emit('network:syncing', { title, detail });
  }

  _armResumeSyncTimeout() {
    if (this._resumeSyncTimer) clearTimeout(this._resumeSyncTimer);
    this._resumeSyncTimer = setTimeout(() => {
      this._resumeSyncTimer = null;
      if (this.syncing) this._forceReconnectForSync();
    }, RESUME_SYNC_TIMEOUT_MS);
  }

  _forceReconnectForSync() {
    if (!this.roomCode || !this.reconnectToken) return false;
    this._startCanonicalSync('RECONNECTING', 'The old connection stopped responding. Replacing it…');
    this._reconnectAttempts = 0;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    const socket = this.socket;
    if (socket) {
      this._localReconnectSockets.add(socket);
      try { socket.close(4001, 'canonical resync'); } catch { /* close can race suspension */ }
      setTimeout(() => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.connected = false;
        this._scheduleReconnect();
      }, 250);
    } else {
      this.connected = false;
      this._scheduleReconnect();
    }
    return true;
  }

  _requestCanonicalSync(reason = 'foreground') {
    if ((!this.active && !this.connected) || !this.roomCode || !this.reconnectToken) return false;
    if (this._sessionTakenOver) {
      if (this._freshForeignResumeTicket()) {
        this._scheduleResumeOwnershipCheck(reason);
        this._status('This match is active in another tab.');
        return false;
      }
      this._sessionTakenOver = false;
      this._persistResumeTicket();
    }
    if (this.syncing) {
      if (this.socket && this.socket.readyState === 1 && this.connected) {
        if (this._resumeSyncTimer) return false;
        this._send({ type: 'sync_request', reason });
        this._armResumeSyncTimeout();
        return true;
      }
      return this._forceReconnectForSync();
    }
    this._reconnectAttempts = 0;
    this._startCanonicalSync('SYNCING MATCH', 'Applying the latest server state before play resumes…');
    const socketOpen = this.socket && this.socket.readyState === 1;
    if (socketOpen && this.connected) {
      this._send({ type: 'sync_request', reason });
      this._armResumeSyncTimeout();
    } else {
      this._forceReconnectForSync();
    }
    return true;
  }

  _completeCanonicalSync() {
    if (!this.syncing) return false;
    this.syncing = false;
    if (this._resumeSyncTimer) clearTimeout(this._resumeSyncTimer);
    this._resumeSyncTimer = null;
    this._sessionTakenOver = false;
    this._pendingCanonicalSelfState = null;
    if (!this.isHost) this._authoritySuspended = false;
    if (this._ui?.syncOverlay) this._ui.syncOverlay.style.display = 'none';
    this._persistResumeTicket();
    this.game?.events?.emit('network:synced', {
      room: this.roomCode,
      matchId: this.matchId,
      snapshotSeq: this._snapshotSeq,
    });
    this.game?.events?.emit('hud:notice', { text: 'Latest server state restored.' });
    return true;
  }

  _setConnecting(connecting) {
    this._connecting = !!connecting;
    if (!this._ui) return;
    this._ui.panel.classList.toggle('connecting', this._connecting);
    this._ui.panel.setAttribute('aria-busy', this._connecting ? 'true' : 'false');
    for (const button of this._ui.panel.querySelectorAll('#mp-create,#mp-join,.mp-room-card')) {
      const unavailable = button.classList.contains('unavailable');
      button.disabled = this._connecting || unavailable;
    }
  }

  _refreshRoomsIfVisible() {
    if (!this._ui || this.connected || this.active) return;
    const menu = this.game.hudRoot?.querySelector('#hud-menu');
    if (!menu || getComputedStyle(menu).display === 'none') return;
    this.refreshRooms();
  }

  async refreshRooms() {
    if (!this._ui || this.connected || this.active) return;
    const request = ++this._roomDirectoryRequest;
    if (this._roomDirectoryController) this._roomDirectoryController.abort();
    this._roomDirectoryController = typeof AbortController === 'function' ? new AbortController() : null;
    this._ui.refresh.classList.add('loading');
    this._ui.refresh.disabled = true;
    this._ui.roomsMeta.textContent = 'SCANNING…';
    if (!this._ui.rooms.children.length) {
      this._ui.rooms.innerHTML = '<div class="mp-room-state"><i></i><strong>SCANNING LIVE ROOMS</strong><small>Contacting Tiny Strike Network…</small></div>';
    }
    try {
      const result = await fetchRoomDirectory({ signal: this._roomDirectoryController?.signal });
      if (request !== this._roomDirectoryRequest) return;
      this._renderRooms(result.rooms);
    } catch (error) {
      if (request !== this._roomDirectoryRequest || error?.name === 'AbortError') return;
      this._ui.roomsMeta.textContent = 'DISCOVERY OFFLINE';
      this._ui.rooms.innerHTML = '<div class="mp-room-state error"><b>!</b><strong>ROOM LIST UNAVAILABLE</strong><small>Direct room codes still work.</small></div>';
    } finally {
      if (request === this._roomDirectoryRequest) {
        this._ui.refresh.classList.remove('loading');
        this._ui.refresh.disabled = false;
        this._roomDirectoryController = null;
      }
    }
  }

  _renderRooms(rooms) {
    if (!this._ui) return;
    const visible = Array.isArray(rooms) ? rooms : [];
    const open = visible.filter((room) => room.joinable).length;
    this._ui.roomsMeta.textContent = `${open} OPEN · ${visible.length} LIVE`;
    if (!visible.length) {
      this._ui.rooms.innerHTML = '<div class="mp-room-state empty"><b>+</b><strong>NO LIVE ROOMS YET</strong><small>Create one and be the first in.</small></div>';
      return;
    }

    this._ui.rooms.innerHTML = visible.map((room) => {
      const view = roomPresentation(room);
      const colors = view.map.colors;
      const unavailable = room.joinable ? '' : ' unavailable';
      const disabled = room.joinable && !this._connecting ? '' : ' disabled';
      const current = room.reservedPlayers > room.players
        ? `${room.players}<small>+${room.reservedPlayers - room.players}</small>`
        : String(room.players);
      return `<button type="button" class="mp-room-card${unavailable}" data-room-code="${room.code}"${disabled} ` +
        `style="--room-a:${colors[0]};--room-b:${colors[1]};--room-c:${colors[2]}" aria-label="Join room ${room.code}">` +
        '<span class="mp-room-art" aria-hidden="true"><i></i></span>' +
        `<span class="mp-room-copy"><strong>${room.code}</strong><small>${view.map.name.toUpperCase()} · ${view.modeLabel}</small></span>` +
        `<span class="mp-room-phase"><b>${view.status.label}</b><small>${view.status.detail}</small></span>` +
        `<span class="mp-room-count"><strong>${current}<em>/${room.maxPlayers}</em></strong><small>PLAYERS</small></span>` +
        '</button>';
    }).join('');
    for (const button of this._ui.rooms.querySelectorAll('.mp-room-card:not(.unavailable)')) {
      button.addEventListener('click', () => this.connect('join', button.dataset.roomCode));
    }
  }

  setTeam(team) {
    this._send({ type: 'set_team', team: team === 't' ? 't' : 'ct' });
  }

  setMap(mapId) {
    if (!this.connected || this.active || !this.isHost) return;
    this._send({ type: 'set_map', mapId: normalizeMapId(mapId) });
  }

  startMatch() {
    this._send({ type: 'start_match' });
  }

  /** Whether this browser tab owns the ranked identity for its room seat. */
  isRankedParticipant() {
    if (typeof this._seatRanked === 'boolean') return this._seatRanked;
    return !this._unrankedIdentityConflict;
  }

  /**
   * A finished online room cannot be restarted by only one browser: doing so
   * would fork the local simulation from the authoritative room. Leave the
   * completed room and reload the menu/room directory instead.
   */
  leaveRoomAndReturn() {
    this._resumeDisabled = true;
    this._clearResumeTicket({ allMatching: true });
    this._send({ type: 'leave_room' });
    setTimeout(() => {
      try { globalThis.location?.reload?.(); } catch { /* test/embedded context */ }
    }, 50);
  }

  applyDamageToRemote(target, amount, info = {}) {
    if (!this.active || !this.isAuthority() || !target || !target.alive || !(amount > 0)) return;
    let healthDamage = amount;
    if (target.armor > 0) {
      healthDamage = amount * (info.headshot ? 0.85 : this.game.config.ARMOR_DAMAGE_SCALE);
      target.armor = Math.max(0, target.armor - amount * 0.5);
    }
    target.health = Math.max(0, target.health - healthDamage);
    const died = target.health <= 0;
    if (died) this._setRemoteAlive(target, false);
    const attacker = info.from || null;
    const result = {
      health: target.health,
      armor: target.armor,
      alive: target.alive,
      amount: healthDamage,
      weapon: info.weapon || 'world',
      headshot: !!info.headshot,
      attackerId: attacker && attacker.networkId ? attacker.networkId : (attacker === this.game.player ? this.localId : null),
      attackerName: attacker && attacker.name ? attacker.name : (attacker === this.game.player ? this.localName : null),
      attackerTeam: attacker && attacker.team ? attacker.team : null,
    };
    this._send({ type: 'damage', targetId: target.networkId, result });
    this.game.events.emit('remote:damage', { player: target, ...result, from: attacker });
    if (died) {
      this.game.events.emit('remote:death', {
        player: target,
        killer: attacker,
        weapon: result.weapon,
        headshot: result.headshot,
      });
    }
  }

  _bindEvents() {
    const ev = this.game.events;
    ev.on('game:end', () => {
      this._resumeDisabled = true;
      this._clearResumeTicket({ allMatching: true });
    });
    ev.on('weapon:fire', (data) => {
      if (!this.active || this.syncing || this.isHost || !data || !data.origin || !data.dir) return;
      this._send({
        type: 'fire',
        weaponId: data.weaponId,
        origin: vec(data.origin),
        dir: vec(data.dir),
        melee: !!data.melee,
      });
    });
    ev.on('grenade:throw', (data) => {
      if (!this.active || this.syncing || this.isHost || !data || !data.origin || !data.dir) return;
      this._send({
        type: 'grenade',
        grenadeType: data.type,
        origin: vec(data.origin),
        dir: vec(data.dir),
        strength: data.strength,
      });
    });
    for (const eventName of EFFECT_EVENTS) {
      ev.on(eventName, (data) => {
        if (!this.active || !this.isAuthority() || this._networkEvent || (data && data._network)) return;
        if (eventName === 'fx:tracer' && data?.shooterId) {
          const shooter = this._remoteById.get(data.shooterId);
          if (shooter) shooter.fireAnim = 1;
        }
        this._send({ type: 'event', event: eventName, data: serializable(data || {}) });
      });
    }
    ev.on('ui:map-select', (data) => {
      const requested = data && (data.mapId || data.id);
      if (!requested || !this.connected || this.active || !this.localId) return;
      if (this.isHost) this.setMap(requested);
      else {
        this._applyRoomMap(this.mapId);
        this.game.events.emit('hud:notice', { text: 'Only the room host can change the map.' });
      }
    });
    ev.on('profile:changed', (event) => {
      this.localName = safeName(event?.name);
      if (this._ui?.name) this._ui.name.value = this.localName;
      if (this.connected) {
        this._send({
          type: 'set_profile',
          name: this.localName,
          characterId: normalizeCharacterId(event?.characterId),
        });
      }
    });
  }

  _bindLifecycle() {
    const doc = typeof document === 'object' && document ? document : null;
    const win = typeof window === 'object' && window ? window : null;

    // Pointer unlock (Escape and the buy menu) is intentionally absent: it
    // pauses only local input. Yield solely when the page may stop executing.
    this._onAuthorityVisibility = () => {
      if (doc && doc.visibilityState === 'hidden') {
        this._lifecycleSuspended = true;
        this._persistResumeTicket();
        this._yieldAuthority();
      } else if (doc && doc.visibilityState === 'visible') {
        this._yieldedAuthorityEpoch = null;
        if (this._lifecycleSuspended) {
          this._lifecycleSuspended = false;
          this._requestCanonicalSync('visibility');
        }
      }
    };
    this._onAuthorityPageHide = () => {
      this._lifecycleSuspended = true;
      this._persistResumeTicket();
      this._yieldAuthority();
    };
    this._onAuthorityFreeze = () => {
      this._lifecycleSuspended = true;
      this._persistResumeTicket();
      this._yieldAuthority();
    };
    this._onAuthorityPageShow = () => {
      this._yieldedAuthorityEpoch = null;
      if (this._lifecycleSuspended) {
        this._lifecycleSuspended = false;
        this._requestCanonicalSync('pageshow');
      }
    };
    this._onNetworkOnline = () => {
      this._requestCanonicalSync('online');
    };
    this._onNetworkOffline = () => {
      if (!this.active && !this.connected) return;
      this._startCanonicalSync('OFFLINE', 'Network connection lost. Waiting to restore the latest room state…');
      if (this.socket) {
        try { this.socket.close(4000, 'browser offline'); } catch { /* browser owns final close */ }
      }
    };

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', this._onAuthorityVisibility);
      // Chromium's Page Lifecycle API fires `freeze` before suspending a tab.
      doc.addEventListener('freeze', this._onAuthorityFreeze);
    }
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('pagehide', this._onAuthorityPageHide);
      win.addEventListener('pageshow', this._onAuthorityPageShow);
      win.addEventListener('online', this._onNetworkOnline);
      win.addEventListener('offline', this._onNetworkOffline);
    }
  }

  _yieldAuthority() {
    if (!this.active || !this.connected) return false;
    if (!this.isHost) {
      this._send({ type: 'player_state', state: this._localState() });
      return false;
    }
    const epoch = Number.isFinite(this._authorityEpoch) ? this._authorityEpoch : -1;
    if (this._yieldedAuthorityEpoch === epoch) return false;
    this._yieldedAuthorityEpoch = epoch;
    // WebSocket ordering guarantees this final canonical frame is accepted
    // before the lease transfer, avoiding rollback of a just-finished kill,
    // grenade throw, or round transition when the page is backgrounded.
    this._send({ type: 'player_state', state: this._localState() });
    this._send({
      type: 'snapshot',
      ...(epoch >= 0 ? { authorityEpoch: epoch } : {}),
      snapshot: this._makeSnapshot(),
    });
    this._authoritySuspended = true;
    if (this.game?.combat && typeof this.game.combat.suspendNetworkAuthority === 'function') {
      this.game.combat.suspendNetworkAuthority();
    }
    this._send({
      type: 'yield_authority',
      ...(epoch >= 0 ? { authorityEpoch: epoch } : {}),
    });
    return true;
  }

  _acceptAuthorityMetadata(message) {
    if (!message || typeof message !== 'object') return false;
    const epoch = protocolCounter(message.authorityEpoch);
    const currentEpoch = Number.isFinite(this._authorityEpoch) ? this._authorityEpoch : -1;
    if (epoch !== null && epoch < currentEpoch) return false;
    if (epoch !== null && epoch === currentEpoch && currentEpoch >= 0 &&
      message.hostId && this.hostId && message.hostId !== this.hostId) {
      return false;
    }
    if (epoch !== null && epoch > currentEpoch) {
      this._authorityEpoch = epoch;
      this._yieldedAuthorityEpoch = null;
    }
    const serverTime = message.serverTime === null || message.serverTime === undefined
      ? NaN
      : Number(message.serverTime);
    if (Number.isFinite(serverTime)) {
      this._serverTime = Math.max(Number(this._serverTime) || 0, serverTime);
    }
    return true;
  }

  _applySnapshotEnvelope(message, options = {}) {
    if (!message || !message.snapshot) return false;
    if (!options.metadataAccepted && !this._acceptAuthorityMetadata(message)) return false;
    if (!options.force && this.isHost) return false;

    const seq = protocolCounter(message.snapshotSeq);
    const currentSeq = Number.isFinite(this._snapshotSeq) ? this._snapshotSeq : -1;
    if (!options.forceReplay && seq !== null && seq <= currentSeq) return false;
    // Once the ordered protocol is active, an unsequenced snapshot must not
    // be allowed to roll canonical state backward. Before that, accepting an
    // unsequenced snapshot preserves compatibility with an older room server.
    if (seq === null && currentSeq >= 0) return false;

    const applied = this._applySnapshot(message.snapshot);
    if (applied === false) return false;
    if (seq !== null) this._snapshotSeq = seq;
    return true;
  }

  _resumeAuthoritySimulation(announce = false) {
    this._authoritySuspended = false;
    if (this.game.bots && typeof this.game.bots.resumeNetworkAuthority === 'function') {
      this.game.bots.resumeNetworkAuthority();
    }
    if (this.game.combat && typeof this.game.combat.resumeNetworkAuthority === 'function') {
      this.game.combat.resumeNetworkAuthority();
    }
    this._sendAccum = 0;
    this._snapshotAccum = 0;
    this._yieldedAuthorityEpoch = null;
    if (announce) {
      this.game.events.emit('network:host', {
        hostId: this.hostId,
        authorityEpoch: this._authorityEpoch,
      });
    }
    this._send({
      type: 'snapshot',
      ...(this._authorityEpoch >= 0 ? { authorityEpoch: this._authorityEpoch } : {}),
      snapshot: this._makeSnapshot(),
    });
  }

  _handleHostChanged(message, options = {}) {
    if (!this._acceptAuthorityMetadata(message)) return false;
    const nextHostId = message.hostId || this.hostId;
    if (!nextHostId) return false;

    const wasHost = !!this.isHost;
    const pendingResume = !!this._authorityResumePending && this.localId === nextHostId;
    // Snapshot application deliberately happens while this peer is a replica:
    // Rounds.applyNetworkSnapshot rejects updates once isAuthority() is true.
    this.isHost = false;
    if (options.applySnapshot !== false) {
      this._applySnapshotEnvelope(message, {
        force: true,
        forceReplay: !!(options.resumeAuthority || options.forceReplay),
        metadataAccepted: true,
      });
    }
    this.hostId = nextHostId;
    this.isHost = this.localId === this.hostId;
    if (wasHost && !this.isHost) {
      this._authoritySuspended = true;
      if (this.game.combat && typeof this.game.combat.suspendNetworkAuthority === 'function') {
        this.game.combat.suspendNetworkAuthority();
      }
    }
    if (options.renderLobby !== false) this._renderLobby();

    if (this.active && this.isHost && !message.snapshot && options.deferPromotionWithoutSnapshot && !wasHost) {
      this._authorityResumePending = true;
      this._authoritySuspended = true;
      return true;
    }

    if (this.active && this.isHost && (!wasHost || options.resumeAuthority || pendingResume)) {
      this._authorityResumePending = false;
      this._resumeAuthoritySimulation(!wasHost || pendingResume);
    }
    return true;
  }

  _onMessage(message) {
    switch (message.type) {
      case 'welcome':
        this._setConnecting(false);
        this._resumeDisabled = false;
        this._seatRanked = message.ranked !== false;
        this._unrankedIdentityConflict = this._joiningUnranked && !this._seatRanked;
        this._joiningUnranked = false;
        this.localId = message.id;
        this.roomCode = message.room;
        this.mode = message.mode;
        this.reconnectToken = String(message.reconnectToken || this.reconnectToken || '');
        this._canPersistResumeTicket = this._seatRanked;
        this._persistResumeTicket();
        this._commitPendingProfile();
        this._reconnectAttempts = 0;
        this._reconnecting = false;
        if (message.lateJoin || message.spectating) {
          this.waitingForNextRound = true;
          this.joinRound = positiveRound(message.joinRound);
          this._pendingLiveJoin = true;
        }
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        if (message.resumed && this.active) {
          const wasAuthority = this.isHost;
          this._handleHostChanged(message, {
            renderLobby: false,
            deferPromotionWithoutSnapshot: true,
          });
          this._resumeAuthorityOnMatchResume = wasAuthority && this.isHost;
          break;
        }
        if (this._acceptAuthorityMetadata(message)) {
          this.hostId = message.hostId || this.hostId;
          this.isHost = this.localId === this.hostId;
        }
        this._applyRoomMap(message.mapId);
        this._ui.room.value = this.roomCode;
        this._ui.mode.value = this.mode;
        this._ui.connect.style.display = 'none';
        this._ui.lobby.style.display = 'block';
        const solo = this.game.hudRoot.querySelector('#hud-start');
        if (solo) solo.style.display = 'none';
        const unrankedSeat = !this.isRankedParticipant();
        this._status(this._pendingLiveJoin
          ? `Match in progress — joining as spectator${this.joinRound ? ` until round ${this.joinRound}` : ''}.` +
            (unrankedSeat ? ' This seat is unranked.' : '')
          : unrankedSeat
            ? (this._unrankedIdentityConflict
                ? 'Room joined as an unranked guest; your other window keeps leaderboard credit.'
                : 'Room joined unranked because leaderboard identity is unavailable; the match remains playable.')
            : 'Room joined. Choose a side and wait for the host.');
        break;
      case 'lobby':
        if (!this._handleHostChanged(message, {
          applySnapshot: this.active,
          renderLobby: false,
        })) break;
        this.mode = message.mode;
        if (!this.active) this._applyRoomMap(message.mapId);
        else this.mapId = normalizeMapId(message.mapId || this.mapId);
        this.roster = Array.isArray(message.players) ? message.players : [];
        if (this.active) this._syncActiveRoster();
        else if (!this._pendingLiveJoin) this._renderLobby();
        if (!this.active && this.syncing) this._completeCanonicalSync();
        break;
      case 'roster_update':
        if (!this._handleHostChanged(message, {
          applySnapshot: this.active,
          renderLobby: false,
        })) break;
        if (message.mode) this.mode = message.mode === 'humans' ? 'humans' : 'mixed';
        this.roster = Array.isArray(message.players) ? message.players : this.roster;
        if (this.active) this._syncActiveRoster();
        else if (!this._pendingLiveJoin) this._renderLobby();
        break;
      case 'match_start':
        this._beginMatch(message);
        break;
      case 'match_resume':
        this._pendingCanonicalSelfState = message.selfState || null;
        this._hydrateRosterStats(message.players);
        if (!this.active) {
          const began = this._beginMatch(message, {
            lateJoin: !!(message.lateJoin || message.spectating || this._pendingLiveJoin),
            snapshot: message.snapshot || null,
          });
          if (began && message.snapshot) {
            this._applyLocalCanonicalState(message.snapshot, {
              includePose: true,
              includeLoadout: true,
              selfState: message.selfState,
            });
            this._completeCanonicalSync();
          } else if (began && message.hostId === this.localId && protocolCounter(message.snapshotSeq) === 0) {
            // The room was restored in the tiny interval between match_start
            // and its first authority frame. As the retained authority, this
            // initialized round-one state is the only canonical baseline.
            this._completeCanonicalSync();
          }
          break;
        }
        {
          const canonicalSync = this.syncing;
          this.matchId = message.matchId || this.matchId;
          this.mode = message.mode === 'humans' ? 'humans' : 'mixed';
          this.mapId = normalizeMapId(message.mapId || this.mapId);
          this.roster = Array.isArray(message.players) ? message.players : this.roster;
          if (this.active) this._syncActiveRoster();
          if (message.spectating || message.waitingForRound) {
            this.waitingForNextRound = true;
            this.joinRound = positiveRound(message.joinRound || message.eligibleRound);
            this.game.player?.waitForNextRound?.();
          }
          const resumeAuthority = !!this._resumeAuthorityOnMatchResume ||
            (canonicalSync && message.hostId === this.localId);
          this._resumeAuthorityOnMatchResume = false;
          const handled = this._handleHostChanged(message, {
            renderLobby: false,
            resumeAuthority,
            forceReplay: canonicalSync,
          });
          if (this.active && handled && message.snapshot) {
            this._applyLocalCanonicalState(message.snapshot, {
              includePose: canonicalSync,
              includeLoadout: canonicalSync,
              selfState: message.selfState,
            });
          }
          const emptyAuthorityBaseline = !message.snapshot && message.hostId === this.localId &&
            protocolCounter(message.snapshotSeq) === 0;
          if (canonicalSync && handled && (message.snapshot || emptyAuthorityBaseline)) {
            this._completeCanonicalSync();
          }
        }
        break;
      case 'player_ready':
        this._onPlayerReady(message);
        break;
      case 'host_changed':
        this._handleHostChanged(message);
        break;
      case 'authority_retained':
        if (!this._acceptAuthorityMetadata(message) || message.hostId !== this.localId) break;
        {
        const canonicalSync = this.syncing;
        this.isHost = false;
        this._applySnapshotEnvelope(message, {
          force: true,
          forceReplay: true,
          metadataAccepted: true,
        });
        if (canonicalSync && message.snapshot) {
          this._applyLocalCanonicalState(message.snapshot, {
            includePose: true,
            includeLoadout: true,
            selfState: message.selfState,
          });
        }
        this.hostId = message.hostId;
        this.isHost = true;
        this._authorityResumePending = false;
        this._resumeAuthoritySimulation(false);
        if (canonicalSync && message.snapshot) this._completeCanonicalSync();
        }
        break;
      case 'player_state':
        this._applyPlayerState(message.id, message.state);
        break;
      case 'snapshot':
        {
        let applied = false;
        if (message.hostId && message.hostId !== this.hostId) {
          applied = this._handleHostChanged(message);
        } else if (this._acceptAuthorityMetadata(message) && !this.isHost) {
          applied = this._applySnapshotEnvelope(message, { metadataAccepted: true });
        }
        if (this.syncing && applied && message.snapshot) {
          this._applyLocalCanonicalState(message.snapshot, {
            includePose: true,
            includeLoadout: true,
            selfState: this._pendingCanonicalSelfState,
          });
          this._completeCanonicalSync();
        }
        }
        break;
      case 'fire': {
        if (!this.isHost) break;
        const shooter = this._remoteById.get(message.shooterId);
        if (shooter && this.game.combat && typeof this.game.combat.fireRemote === 'function') {
          this.game.combat.fireRemote(message, shooter);
        }
        break;
      }
      case 'grenade': {
        if (!this.isHost) break;
        const shooter = this._remoteById.get(message.shooterId);
        if (shooter && this.game.combat && typeof this.game.combat.throwRemoteGrenade === 'function') {
          this.game.combat.throwRemoteGrenade(message, shooter);
        }
        break;
      }
      case 'damage':
        this._applyDamageMessage(message);
        break;
      case 'event':
        this._applyNetworkEvent(message.event, message.data || {});
        break;
      case 'player_left':
        this._removeRemote(message.id);
        if (this.active) this.game.events.emit('hud:notice', { text: `${message.name || 'A player'} disconnected` });
        break;
      case 'leaderboard_result':
        this._handleLeaderboardResult(message);
        break;
      case 'leaderboard_error':
        this._handleLeaderboardError(message);
        break;
      case 'error':
        this._setConnecting(false);
        this._status(message.message || 'Online error.', true);
        if (this._reconnecting && this.socket) {
          const failed = this.socket;
          this.socket = null;
          this.connected = false;
          this._reconnecting = false;
          failed.close();
          if (message.code === 'resume_not_found' || message.code === 'resume_expired') {
            this._resumeDisabled = true;
            this._clearResumeTicket({ allMatching: true });
            this.reconnectToken = '';
            this._startCanonicalSync('SESSION EXPIRED', 'That room seat is no longer available. Returning to the main menu…');
            setTimeout(() => {
              try { globalThis.location?.reload?.(); } catch { /* test/embedded context */ }
            }, 1_500);
          } else {
            this._showDisconnected();
          }
        } else if (!this.localId && this.socket) {
          const failed = this.socket;
          this.socket = null;
          this.connected = false;
          failed.close();
        }
        break;
      default:
        break;
    }
  }

  /** Deliver a room-server leaderboard result through the same event contract
   *  used by solo submissions. The room service sends this frame only to the
   *  credited participant; the ID/match fences provide defense in depth and
   *  prevent a late result from celebrating over a newer match. */
  _handleLeaderboardResult(message) {
    if (!message || typeof message !== 'object') return false;
    const targetId = message.playerId ?? message.targetId ?? null;
    if (targetId != null && String(targetId) !== String(this.localId || '')) return false;

    const candidate = message.response && typeof message.response === 'object'
      ? message.response
      : message.submission && typeof message.submission === 'object'
        ? message.submission
        : null;
    const rawResult = candidate || (message.result && typeof message.result === 'object' ? message.result : {});
    const publicResult = rawResult.result && typeof rawResult.result === 'object'
      ? rawResult.result
      : rawResult;
    const matchId = String(
      message.matchId || publicResult.matchId || message.payload?.matchId || ''
    ).trim();
    if (matchId && this.matchId && matchId !== String(this.matchId)) return false;

    if (!(this._leaderboardResultsSeen instanceof Set)) this._leaderboardResultsSeen = new Set();
    if (matchId && this._leaderboardResultsSeen.has(matchId)) return false;

    const standing = rawResult.standing || message.standing || null;
    const response = candidate
      ? { ...candidate }
      : {
          accepted: message.accepted !== false,
          duplicate: !!message.duplicate,
          result: publicResult,
        };
    if (!response.result || typeof response.result !== 'object') response.result = publicResult;
    if (standing && !response.entry) response.entry = standing;
    if (standing && (!response.player || response.player === rawResult.player)) response.player = standing;
    if (message.entry && !response.entry) response.entry = message.entry;
    if (message.player && !response.player) response.player = message.player;

    if (matchId) {
      this._leaderboardResultsSeen.add(matchId);
      while (this._leaderboardResultsSeen.size > 32) {
        this._leaderboardResultsSeen.delete(this._leaderboardResultsSeen.values().next().value);
      }
    }
    this.game?.events?.emit('leaderboard:submitted', {
      payload: message.payload && typeof message.payload === 'object'
        ? message.payload
        : (matchId ? { matchId } : {}),
      response,
      source: 'room-server',
    });
    return true;
  }

  /** Surface a terminal, authoritative room-ranking failure instead of
   * leaving the match summary in an endless “verifying” state. */
  _handleLeaderboardError(message) {
    if (!message || typeof message !== 'object') return false;
    const targetId = message.playerId ?? message.targetId ?? null;
    if (targetId != null && String(targetId) !== String(this.localId || '')) return false;
    const matchId = String(message.matchId || '').trim();
    if (matchId && this.matchId && matchId !== String(this.matchId)) return false;
    if (!(this._leaderboardResultsSeen instanceof Set)) this._leaderboardResultsSeen = new Set();
    if (matchId && this._leaderboardResultsSeen.has(matchId)) return false;
    if (matchId) {
      this._leaderboardResultsSeen.add(matchId);
      while (this._leaderboardResultsSeen.size > 32) {
        this._leaderboardResultsSeen.delete(this._leaderboardResultsSeen.values().next().value);
      }
    }
    this.game?.events?.emit('leaderboard:submit-error', {
      payload: matchId ? { matchId } : {},
      error: String(message.message || 'Match rewards could not be recorded.'),
      code: String(message.code || 'leaderboard_submission_failed'),
      permanent: true,
      source: 'room-server',
    });
    return true;
  }

  _beginMatch(message, options = {}) {
    if (!this._acceptAuthorityMetadata(message)) return false;
    const lateJoin = !!(options.lateJoin || message.lateJoin || message.spectating);
    const snapshot = options.snapshot || message.snapshot || null;
    const snapshotEnvelope = snapshot === message.snapshot ? message : { ...message, snapshot };
    this._applyRoomMap(message.mapId);
    this.active = true;
    this.matchId = message.matchId || null;
    this.mode = message.mode === 'humans' ? 'humans' : 'mixed';
    this.hostId = message.hostId;
    this.isHost = this.localId === this.hostId;
    this.roster = Array.isArray(message.players) ? message.players : [];
    const mine = this.roster.find((p) => p.id === this.localId);
    if (!mine) return;

    this.waitingForNextRound = lateJoin;
    this.joinRound = lateJoin
      ? (positiveRound(message.joinRound) || positiveRound(mine.joinRound) ||
        ((positiveRound(snapshot?.state?.round) || 0) + 1))
      : null;
    this._pendingLiveJoin = false;

    this.localName = mine.name || this.localName;
    const localCharacterId = normalizeCharacterId(mine.characterId || this.game.profile?.characterId);
    if (this.game.profile && !this._unrankedIdentityConflict) {
      this.game.profile.update({ name: this.localName, characterId: localCharacterId });
    }
    this.game.sessionMode = this.mode;
    this.game.player.team = mine.team;
    this.game.player.name = this.localName;
    this.game.player.characterId = localCharacterId;
    if (!this.isRankedParticipant()) {
      this.game.events.emit('hud:notice', {
        text: this._unrankedIdentityConflict
          ? 'Unranked guest — your other window keeps leaderboard credit.'
          : 'Unranked room seat — leaderboard identity is unavailable.',
      });
    }
    if (this.game.viewmodel?.applyProfileAppearance) {
      this.game.viewmodel.applyProfileAppearance(localCharacterId);
    }
    this.game.player.networkId = this.localId;
    this._rebuildRemotes();

    const snapshotBotCounts = lateJoin && Array.isArray(snapshot?.bots)
      ? botCountsForSnapshot(snapshot)
      : null;
    const botCounts = snapshotBotCounts || botCountsForRoster(this.roster, this.mode);
    this._configureBots(botCounts);
    this._queueBotRosterRebalance();

    this._ui.panel.style.display = 'none';
    this.game.events.emit('network:match-start', {
      mode: this.mode,
      roster: this.roster,
      botCounts,
      localId: this.localId,
      hostId: this.hostId,
    });
    this.game.events.emit('ui:start');
    if (lateJoin) {
      const currentRound = positiveRound(snapshot?.state?.round) || Math.max(1, (this.joinRound || 2) - 1);
      // The local rounds module creates round one during ui:start. Align its
      // cursor before applying the current snapshot so it cannot interpret the
      // current live round as a spawn boundary for this late joiner.
      this.game.state.round = currentRound;
      if (this.game.player && typeof this.game.player.waitForNextRound === 'function') {
        this.game.player.waitForNextRound();
      } else if (this.game.player) {
        this.game.player.health = 0;
        this.game.player.alive = false;
        this.game.player.spectatorReady = true;
      }
      this.game.events.emit('hud:notice', {
        text: `Joined mid-round — spectating until round ${this.joinRound || currentRound + 1}.`,
      });
      this.game.events.emit('network:waiting-for-round', {
        round: this.joinRound || currentRound + 1,
      });
    }
    if (snapshot) {
      if (this.isHost) {
        // A late join can inherit an abandoned room before its local game is
        // initialized. Hydrate after roster/startup setup, while temporarily a
        // replica, then begin the new lease from that exact canonical frame.
        this.isHost = false;
        this._applySnapshotEnvelope(snapshotEnvelope, {
          force: true,
          forceReplay: true,
          metadataAccepted: true,
        });
        this.isHost = true;
        this._authorityResumePending = false;
        this._resumeAuthoritySimulation(false);
      } else {
        this._applySnapshotEnvelope(snapshotEnvelope, { metadataAccepted: true });
      }
    } else if (this.isHost) {
      this._authoritySuspended = false;
    }
    if (this.game.input && typeof this.game.input.requestLock === 'function') this.game.input.requestLock();
    return true;
  }

  _configureBots(counts) {
    const bots = this.game.bots;
    if (!bots || typeof bots.configureRoster !== 'function') return;
    const ct = Math.max(0, Math.floor(Number(counts?.ct) || 0));
    const t = Math.max(0, Math.floor(Number(counts?.t) || 0));
    if (bots._ctCount === ct && bots._tCount === t && Array.isArray(bots.all)) return;
    bots.configureRoster(ct, t);
  }

  _queueBotRosterRebalance() {
    let next = null;
    const currentRound = positiveRound(this.game.state?.round) || 0;
    for (const entry of this.roster) {
      const round = positiveRound(entry?.joinRound);
      if (!round || round <= currentRound) continue;
      next = next === null ? round : Math.min(next, round);
    }
    this._botRosterPendingRound = next;
  }

  /** Called by Rounds immediately before bots reset at a round boundary. */
  prepareRoundRoster(roundValue) {
    const round = positiveRound(roundValue);
    if (!round || !this.active || this._botRosterPendingRound === null || round < this._botRosterPendingRound) return;
    this._configureBots(botCountsForRoster(this.roster, this.mode, round));
    let next = null;
    for (const entry of this.roster) {
      const joinRound = positiveRound(entry?.joinRound);
      if (!joinRound || joinRound <= round) continue;
      next = next === null ? joinRound : Math.min(next, joinRound);
    }
    this._botRosterPendingRound = next;
  }

  _syncActiveRoster() {
    const localEntry = this.roster.find((entry) => entry?.id === this.localId);
    if (localEntry && this.game.player) {
      const nextLocalTeam = localEntry.team === 't' ? 't' : 'ct';
      const teamChanged = this.game.player.team !== nextLocalTeam;
      this.game.player.team = nextLocalTeam;
      this.game.player.name = localEntry.name || this.game.player.name;
      this.localName = localEntry.name || this.localName;
      if (teamChanged && this.game.viewmodel?.applyProfileAppearance) {
        this.game.viewmodel.applyProfileAppearance(
          normalizeCharacterId(localEntry.characterId || this.game.profile?.characterId)
        );
      }
    }

    const nextIds = new Set();
    for (const entry of this.roster) {
      if (!entry || entry.id === this.localId) continue;
      nextIds.add(entry.id);
      let remote = this._remoteById.get(entry.id);
      if (!remote) {
        remote = this._createRemote(entry);
        this.remotePlayers.push(remote);
        this._remoteById.set(remote.networkId, remote);
      } else {
        remote.name = entry.name || remote.name;
        const nextTeam = entry.team === 't' ? 't' : 'ct';
        const teamChanged = remote.team !== nextTeam;
        remote.team = nextTeam;
        remote.spectating = !!entry.spectating;
        remote.joinRound = positiveRound(entry.joinRound);
        if (entry.characterId || teamChanged) {
          this._applyRemoteAppearance(remote, entry.characterId || remote.characterId, teamChanged);
        }
        if (entry.spectating) this._setRemoteAlive(remote, false);
        else if (typeof entry.alive === 'boolean') this._setRemoteAlive(remote, entry.alive);
      }
    }
    this._queueBotRosterRebalance();
    for (const remote of [...this.remotePlayers]) {
      if (!nextIds.has(remote.networkId)) this._removeRemote(remote.networkId);
    }
    if (this.game.hud) this.game.hud._sbDirty = true;
  }

  _hydrateRosterStats(roster) {
    if (this.game.hud && typeof this.game.hud.applyNetworkPlayerStats === 'function') {
      this.game.hud.applyNetworkPlayerStats(roster);
    }
  }

  _onPlayerReady(message) {
    const localWasWaiting = this.waitingForNextRound || this.joinRound !== null;
    const round = positiveRound(message.round);
    const entry = this.roster.find((player) => player.id === message.id);
    if (entry) {
      entry.spectating = false;
      entry.joinRound = null;
    }
    const remote = this._remoteById.get(message.id);
    if (remote) remote.spectating = false;
    if (message.id !== this.localId) return;
    if (!localWasWaiting) return;
    if (this.waitingForNextRound && round && this.joinRound && round < this.joinRound) return;
    this.waitingForNextRound = false;
    this.joinRound = null;
    this.game.events.emit('network:ready', { round: round || this.game.state.round });
    this.game.events.emit('hud:notice', { text: 'Round started — you are now deployed.' });
  }

  _rebuildRemotes() {
    for (const remote of this.remotePlayers) this._destroyRemoteVisual(remote);
    this.remotePlayers.length = 0;
    this._remoteById.clear();
    for (const entry of this.roster) {
      if (entry.id === this.localId) continue;
      const remote = this._createRemote(entry);
      this.remotePlayers.push(remote);
      this._remoteById.set(remote.networkId, remote);
    }
    if (this.game.hud) this.game.hud._sbDirty = true;
  }

  _createRemote(entry) {
    const position = new THREE.Vector3();
    const remote = {
      networkId: entry.id,
      name: entry.name,
      team: entry.team,
      characterId: normalizeCharacterId(entry.characterId),
      position,
      pos: position,
      targetPosition: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      yaw: 0,
      targetYaw: 0,
      pitch: 0,
      health: 100,
      armor: 0,
      hasKit: false,
      alive: entry.alive !== false && !entry.spectating,
      spectating: !!entry.spectating,
      joinRound: positiveRound(entry.joinRound),
      hasNetworkPose: false,
      crouching: false,
      walking: false,
      moveSpeed2D: 0,
      moveSpeed: 0,
      onGround: true,
      useDown: false,
      weaponId: entry.team === 'ct' ? 'usp' : 'glock',
      aimPitch: 0,
      aimBlend: 1,
      fireAnim: 0,
      burstLeft: 0,
      deathTime: -1,
      deathPlayed: false,
      corpseSettled: false,
      fallAxis: 'z',
      fallSign: 1,
      radius: this.game.config.PLAYER.RADIUS,
      height: this.game.config.PLAYER.HEIGHT_STAND,
      isRemotePlayer: true,
      mesh: null,
      hitCapsule: () => ({ pos: remote.position, radius: remote.radius, height: remote.height }),
      takeDamage: (amount, info) => this.applyDamageToRemote(remote, amount, info),
    };
    remote.mesh = this._buildRemoteMesh(remote);
    remote.mesh.userData.remotePlayer = remote;
    remote.mesh.visible = false;
    this.game.scene.add(remote.mesh);
    return remote;
  }

  _buildRemoteMesh(remote) {
    const visuals = this.game.bots;
    const palette = getCharacterPalette(remote.characterId, remote.team);
    if (visuals && typeof visuals.createOperativeVisual === 'function') {
      return visuals.createOperativeVisual(remote, palette);
    }
    // Construction-order/test fallback: stay invisible rather than reviving
    // the obsolete block character.
    const group = new THREE.Group();
    group.name = 'remote-operative-pending';
    return group;
  }

  _applyRemoteAppearance(remote, characterId, force = false) {
    if (!remote) return;
    const nextId = normalizeCharacterId(characterId);
    if (!force && nextId === remote.characterId) return;
    remote.characterId = nextId;
    const visuals = this.game.bots;
    const palette = getCharacterPalette(nextId, remote.team);
    if (visuals && force && typeof visuals.rebuildOperativeVisual === 'function') {
      remote.mesh = visuals.rebuildOperativeVisual(remote, palette);
    } else if (visuals && typeof visuals.updateOperativeAppearance === 'function') {
      visuals.updateOperativeAppearance(remote, palette);
    }
    if (remote.mesh) remote.mesh.userData.remotePlayer = remote;
  }

  _applyPlayerState(id, state) {
    const remote = this._remoteById.get(id);
    if (!remote || !state) return;
    if (state.pos) remote.targetPosition.set(state.pos.x || 0, state.pos.y || 0, state.pos.z || 0);
    if (Number.isFinite(state.yaw)) remote.targetYaw = state.yaw;
    if (Number.isFinite(state.pitch)) remote.pitch = state.pitch;
    if (Number.isFinite(state.health)) remote.health = state.health;
    if (Number.isFinite(state.armor)) remote.armor = state.armor;
    remote.hasKit = !!state.hasKit;
    const wasAlive = remote.alive;
    if (typeof state.alive === 'boolean') this._setRemoteAlive(remote, state.alive);
    remote.crouching = !!state.crouching;
    remote.walking = !!state.walking;
    remote.moveSpeed2D = Number(state.moveSpeed2D) || 0;
    remote.onGround = state.onGround !== false;
    remote.useDown = !!state.useDown;
    remote.weaponId = state.weaponId || remote.weaponId;
    if (state.characterId) this._applyRemoteAppearance(remote, state.characterId);
    remote.height = remote.crouching
      ? this.game.config.PLAYER.HEIGHT_CROUCH
      : this.game.config.PLAYER.HEIGHT_STAND;
    remote.hasNetworkPose = true;
    remote.mesh.visible = this.active && !remote.spectating;
    if (wasAlive !== remote.alive && this.game.hud) this.game.hud._sbDirty = true;
  }

  _updateRemoteBodies(dt) {
    const blend = 1 - Math.exp(-18 * dt);
    for (const remote of this.remotePlayers) {
      if (!remote.mesh) continue;
      remote.position.lerp(remote.targetPosition, blend);
      remote.yaw = angleLerp(remote.yaw, remote.targetYaw, blend);
      remote.mesh.position.copy(remote.position);
      remote.mesh.rotation.y = remote.yaw;
      const standingTop = Number(this.game.config?.PLAYER?.HEIGHT_STAND) || 1.83;
      remote.spectatorVisualTop = remote.crouching ? standingTop * 0.8 : standingTop;
      const visuals = this.game.bots;
      if (visuals && typeof visuals.updateOperativeVisual === 'function') {
        visuals.updateOperativeVisual(remote, dt);
      }
      remote.mesh.visible = this.active && remote.hasNetworkPose && !remote.spectating;
    }
  }

  _setRemoteAlive(remote, alive, snapshot = {}) {
    if (!remote) return false;
    const nextAlive = alive !== false;
    const visuals = this.game.bots;
    if (visuals && typeof visuals.setOperativeAlive === 'function') {
      return visuals.setOperativeAlive(remote, nextAlive, snapshot);
    }
    if (remote.alive === nextAlive) return false;
    remote.alive = nextAlive;
    remote.deathTime = nextAlive ? -1 : (Number(this.game.bots?.time) || 0);
    remote.deathPlayed = false;
    remote.corpseSettled = false;
    if (nextAlive && remote.mesh) remote.mesh.rotation.set(0, remote.yaw || 0, 0);
    return true;
  }

  _destroyRemoteVisual(remote) {
    if (!remote) return;
    const visuals = this.game.bots;
    if (visuals && typeof visuals.destroyOperativeVisual === 'function') {
      visuals.destroyOperativeVisual(remote);
    } else if (remote.mesh?.parent) {
      remote.mesh.parent.remove(remote.mesh);
      remote.mesh = null;
    }
  }

  _localState() {
    const p = this.game.player;
    const input = this.game.input;
    return {
      round: Math.max(0, Math.floor(Number(this.game.state?.round) || 0)),
      pos: vec(p.position),
      yaw: p.yaw,
      pitch: p.pitch,
      health: p.health,
      armor: p.armor,
      hasKit: p.hasKit,
      alive: p.alive,
      crouching: p.crouching,
      walking: p.walking,
      moveSpeed2D: p.moveSpeed2D,
      onGround: p.onGround,
      useDown: !!(input && typeof input.isDown === 'function' && input.isDown('e')),
      weaponId: this.game.weapons ? this.game.weapons.currentId : 'knife',
      inventory: this.game.weapons && typeof this.game.weapons.networkSnapshot === 'function'
        ? this.game.weapons.networkSnapshot()
        : null,
      money: Math.max(0, Math.floor(Number(this.game.state?.money) || 0)),
      economyRound: Math.max(0, Math.floor(Number(this.game.rounds?._economyRound) || 0)),
      characterId: normalizeCharacterId(this.game.profile?.characterId),
    };
  }

  _makeSnapshot() {
    const s = this.game.state;
    const bots = this.game.bots && Array.isArray(this.game.bots.all)
      ? this.game.bots.all.map((b) => ({
          name: b.name,
          team: b.team,
          pos: vec(b.pos),
          yaw: b.yaw,
          aimPitch: b.aimPitch,
          alive: b.alive,
          health: b.health,
          armor: b.armor,
          crouching: b.crouching,
          weaponId: b.weaponId,
          moveSpeed: b.moveSpeed,
          state: b.state,
          plan: b.plan,
          postPlantRole: b.postPlantRole,
          anchor: vec(b.anchor),
          anchorReached: !!b.anchorReached,
          patrolArea: b.patrolArea || null,
          mag: b.mag,
          fireCooldown: b.fireCooldown,
          burstLeft: b.burstLeft,
          pauseTimer: b.pauseTimer,
          reloadTimer: b.reloadTimer,
          plantClearTimer: b.plantClearTimer,
          plantTimer: b.plantTimer,
          defuseTimer: b.defuseTimer,
          blindRemaining: Math.max(0, (Number(b.blindUntil) || 0) - (Number(this.game.bots.time) || 0)),
          blindSpray: !!b.blindSpray,
          fallAxis: b.fallAxis,
          fallSign: b.fallSign,
          isBombCarrier: b === this.game.bots.bombCarrier,
        }))
      : [];
    return {
      state: {
        phase: s.phase,
        round: s.round,
        scores: { ct: s.scores.ct, t: s.scores.t },
        timer: s.timer,
        canBuy: s.canBuy,
        bomb: {
          planted: s.bomb.planted,
          site: s.bomb.site,
          pos: vec(s.bomb.pos),
          defusingBy: typeof s.bomb.defusingBy === 'string' ? s.bomb.defusingBy : null,
          defuseProgress: s.bomb.defuseProgress,
          defuseTime: s.bomb.defuseTime,
          plantProgress: s.bomb.plantProgress,
          plantTime: s.bomb.plantTime,
          carrierId: s.bomb.carrierId || null,
        },
        roundResult: this.game.rounds && typeof this.game.rounds.lastRoundResult === 'function'
          ? this.game.rounds.lastRoundResult()
          : null,
        matchWinner: this.game.rounds ? this.game.rounds._matchWinner : null,
      },
      bots,
      botAuthority: this.game.bots && typeof this.game.bots.networkAuthoritySnapshot === 'function'
        ? this.game.bots.networkAuthoritySnapshot()
        : null,
      combat: this.game.combat && typeof this.game.combat.networkAuthoritySnapshot === 'function'
        ? this.game.combat.networkAuthoritySnapshot()
        : null,
    };
  }

  _applySnapshot(snapshot) {
    if (!snapshot) return false;
    if (Array.isArray(snapshot.players)) {
      for (const entry of snapshot.players) {
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id : null;
        if (!id || id === this.localId) continue;
        const state = entry.state && typeof entry.state === 'object' ? entry.state : entry;
        this._applyPlayerState(id, state);
      }
    }
    const remoteRound = positiveRound(snapshot.state?.round);
    if (remoteRound) this.prepareRoundRoster(remoteRound);
    if (this.waitingForNextRound && remoteRound && this.joinRound && remoteRound >= this.joinRound) {
      // Clear the gate before Rounds consumes the new-round snapshot; that
      // snapshot owns the actual spawn/reset and keeps every client aligned.
      this.waitingForNextRound = false;
      this.game.events.emit('network:ready', { round: remoteRound });
      this.game.events.emit('hud:notice', { text: 'Round started — you are now deployed.' });
    }
    if (snapshot.state && this.game.rounds && typeof this.game.rounds.applyNetworkSnapshot === 'function') {
      this.game.rounds.applyNetworkSnapshot(snapshot.state);
    }
    if (Array.isArray(snapshot.bots) && this.game.bots && typeof this.game.bots.applyNetworkSnapshot === 'function') {
      const aliveChanged = this.game.bots.applyNetworkSnapshot(snapshot.bots);
      if (aliveChanged && this.game.hud) this.game.hud._sbDirty = true;
    }
    if (snapshot.botAuthority && this.game.bots &&
      typeof this.game.bots.applyAuthoritySnapshot === 'function') {
      this.game.bots.applyAuthoritySnapshot(snapshot.botAuthority);
    }
    if (snapshot.state && snapshot.state.bomb && this.game.bots &&
      typeof this.game.bots.applyObjectiveSnapshot === 'function') {
      this.game.bots.applyObjectiveSnapshot(snapshot.state.bomb);
    }
    if (snapshot.combat && this.game.combat &&
      typeof this.game.combat.applyNetworkSnapshot === 'function') {
      this.game.combat.applyNetworkSnapshot(snapshot.combat);
    }
    if (!this.waitingForNextRound && remoteRound && this.joinRound && remoteRound >= this.joinRound) {
      this.joinRound = null;
    }
    return true;
  }

  _applyLocalCanonicalState(snapshot, options = {}) {
    if (!snapshot || !this.localId || !this.game.player) return false;
    const entry = Array.isArray(snapshot.players)
      ? snapshot.players.find((candidate) => candidate?.id === this.localId)
      : null;
    const state = options.selfState && typeof options.selfState === 'object'
      ? options.selfState
      : entry?.state && typeof entry.state === 'object' ? entry.state : null;
    if (!state) return false;
    const snapshotRound = Math.floor(Number(snapshot.state?.round));
    const stateRound = Math.floor(Number(state.round));
    const sameRound = Number.isFinite(snapshotRound) && Number.isFinite(stateRound) && snapshotRound === stateRound;
    const player = this.game.player;
    const health = Number.isFinite(state.health) ? Math.max(0, state.health) : player.health;
    const armor = Number.isFinite(state.armor) ? Math.max(0, state.armor) : player.armor;
    const alive = state.alive !== false && health > 0;
    if (player.alive && !alive && typeof player.applyNetworkDamage === 'function') {
      player.applyNetworkDamage({ health, armor, alive: false, amount: 0, weapon: 'network' }, null);
    } else {
      player.health = health;
      player.armor = armor;
      player.alive = alive;
    }
    if (sameRound && typeof state.hasKit === 'boolean') player.hasKit = state.hasKit;
    if (options.includePose && sameRound) {
      if (state.pos && Number.isFinite(state.pos.x) && Number.isFinite(state.pos.y) && Number.isFinite(state.pos.z)) {
        if (player.position && typeof player.position.set === 'function') {
          player.position.set(state.pos.x, state.pos.y, state.pos.z);
        } else if (player.position) {
          player.position.x = state.pos.x;
          player.position.y = state.pos.y;
          player.position.z = state.pos.z;
        }
      }
      if (Number.isFinite(state.yaw)) player.yaw = state.yaw;
      if (Number.isFinite(state.pitch)) player.pitch = state.pitch;
      if (typeof state.crouching === 'boolean') player.crouching = state.crouching;
      if (typeof state.walking === 'boolean') player.walking = state.walking;
      if (typeof state.onGround === 'boolean') player.onGround = state.onGround;
      if (player.velocity && typeof player.velocity.set === 'function') player.velocity.set(0, 0, 0);
    }
    if (options.includeLoadout && sameRound) {
      if (Number.isFinite(state.money) && this.game.state) {
        this.game.state.money = Math.max(0, Math.floor(state.money));
      }
      if (Number.isFinite(state.economyRound) && this.game.rounds) {
        this.game.rounds._economyRound = Math.max(0, Math.floor(state.economyRound));
      }
      if (Number.isFinite(state.lossStreak) && this.game.rounds) {
        this.game.rounds._lossStreak = Math.max(0, Math.floor(state.lossStreak));
      }
      if (state.inventory && this.game.weapons &&
        typeof this.game.weapons.applyNetworkSnapshot === 'function') {
        this.game.weapons.applyNetworkSnapshot(state.inventory);
        if ((state.roundReset === 'died' || state.roundReset === 'survived') &&
          typeof this.game.weapons.resetForRound === 'function') {
          this.game.weapons.resetForRound({ died: state.roundReset === 'died' });
        }
      }
    }
    return true;
  }

  _applyDamageMessage(message) {
    const result = message.result || {};
    if (!this.isHost && result.attackerId === this.localId && message.targetId !== this.localId) {
      this.game.events.emit('hud:hitmarker', { headshot: !!result.headshot, kill: result.alive === false });
    }
    if (message.targetId === this.localId) {
      if (this.isHost) return;
      const attacker = result.attackerId ? this._remoteById.get(result.attackerId) : null;
      if (this.game.player && typeof this.game.player.applyNetworkDamage === 'function') {
        this.game.player.applyNetworkDamage(result, attacker || {
          name: result.attackerName || 'World',
          team: result.attackerTeam || 't',
        });
      }
      return;
    }
    const remote = this._remoteById.get(message.targetId);
    if (!remote || this.isHost) return;
    remote.health = Number.isFinite(result.health) ? result.health : remote.health;
    remote.armor = Number.isFinite(result.armor) ? result.armor : remote.armor;
    this._setRemoteAlive(remote, result.alive !== false);
  }

  _applyNetworkEvent(eventName, data) {
    if (!EFFECT_EVENTS.includes(eventName)) return;
    const hydrate = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      for (const key of ['pos', 'point', 'normal', 'from', 'to', 'dir', 'origin']) {
        const value = obj[key];
        if (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
          obj[key] = new THREE.Vector3(value.x, value.y, value.z);
        }
      }
      return obj;
    };
    this._networkEvent = true;
    try {
      if (eventName === 'fx:tracer' && data.from && data.to && data.shooterId !== this.localId) {
        const shooter = this._remoteById.get(data.shooterId);
        if (shooter) shooter.fireAnim = 1;
        const direction = new THREE.Vector3(
          data.to.x - data.from.x,
          data.to.y - data.from.y,
          data.to.z - data.from.z
        ).normalize();
        this.game.events.emit('bot:fire', {
          origin: new THREE.Vector3(data.from.x, data.from.y, data.from.z),
          dir: direction,
          weaponId: data.weaponId,
          _network: true,
        });
      }
      if (eventName === 'fx:flash' && data.pos && this.game.combat &&
        typeof this.game.combat.applyNetworkFlash === 'function') {
        this.game.combat.applyNetworkFlash(data.pos);
      }
      if (eventName === 'kill' && !this.isHost && data.killerId === this.localId && Number(data.reward) > 0) {
        const reward = Number(data.reward);
        this.game.state.money = Math.min(this.game.config.ECON.MAX_MONEY, this.game.state.money + reward);
        this.game.events.emit('econ:kill', { weaponId: data.weaponId, reward });
        this.game.events.emit('hud:hitmarker', { headshot: !!data.headshot, kill: true });
      }
      this.game.events.emit(eventName, { ...hydrate(data), _network: true });
    } finally {
      this._networkEvent = false;
    }
  }

  _removeRemote(id) {
    const remote = this._remoteById.get(id);
    if (!remote) return;
    const currentRound = positiveRound(this.game.state?.round) || 1;
    const wasPending = !!remote.spectating || (remote.joinRound && remote.joinRound > currentRound);
    this._destroyRemoteVisual(remote);
    this._remoteById.delete(id);
    const index = this.remotePlayers.indexOf(remote);
    if (index >= 0) this.remotePlayers.splice(index, 1);
    this.roster = this.roster.filter((p) => p.id !== id);
    if (this.active && this.mode === 'mixed') {
      if (wasPending) {
        this._queueBotRosterRebalance();
      } else {
        const refillRound = currentRound + 1;
        this._botRosterPendingRound = this._botRosterPendingRound === null
          ? refillRound
          : Math.min(this._botRosterPendingRound, refillRound);
      }
    }
    if (this.game.hud) this.game.hud._sbDirty = true;
  }

  _send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.syncing && SYNC_BLOCKED_OUTBOUND_TYPES.has(message?.type)) return;
    if (this._authoritySuspended && message?.type !== 'yield_authority' &&
      AUTHORITY_OUTBOUND_TYPES.has(message?.type)) return;
    const needsFence = this.isHost && AUTHORITY_OUTBOUND_TYPES.has(message?.type) &&
      Number.isFinite(this._authorityEpoch);
    const payload = needsFence && message.authorityEpoch === undefined
      ? { ...message, authorityEpoch: this._authorityEpoch }
      : message;
    this.socket.send(JSON.stringify(payload));
  }

  _applyRoomMap(value) {
    const mapId = normalizeMapId(value || this.mapId || this.game.selectedMapId);
    this.mapId = mapId;
    this.game.selectedMapId = mapId;
    if (this.game.world && typeof this.game.world.loadMap === 'function') {
      this.game.world.loadMap(mapId);
    } else if (this.game.events) {
      this.game.events.emit('world:select-map', { mapId });
    }
  }

  _buildUI() {
    const menu = this.game.hudRoot && this.game.hudRoot.querySelector('#hud-menu');
    if (!menu) return;
    const savedName = this.game.profile?.name || localStorage.getItem('tiny-strike-player-name') ||
      localStorage.getItem('goldeneye-name') || 'Operative';
    const panel = document.createElement('div');
    panel.id = 'mp-panel';
    panel.innerHTML = `
      <div id="mp-connect">
        <div class="mp-connect-grid">
          <div class="mp-create-side">
            <div class="mp-title"><span>ONLINE PLAY</span><small>CREATE OR JOIN A FIRETEAM</small></div>
            <label class="mp-field-label" for="mp-name">CALLSIGN</label>
            <div class="mp-row"><input id="mp-name" maxlength="20" value="${savedName.replace(/[<&\"]/g, '')}" placeholder="Callsign" autocomplete="nickname"></div>
            <div class="mp-row">
              <select id="mp-mode" aria-label="Room mode"><option value="mixed">HUMANS + BOTS</option><option value="humans">HUMANS ONLY</option></select>
              <input id="mp-room" maxlength="6" placeholder="ROOM CODE" aria-label="Room code" autocomplete="off">
            </div>
            <div class="mp-actions"><button id="mp-create" type="button">CREATE ROOM</button><button id="mp-join" type="button">JOIN CODE</button></div>
            <div id="mp-status">Choose a live room, create one, or enter a code.</div>
          </div>
          <section class="mp-directory" aria-labelledby="mp-directory-title">
            <div class="mp-directory-head"><div><span id="mp-directory-title">LIVE ROOMS</span><small id="mp-rooms-meta">SCANNING…</small></div><button id="mp-refresh" type="button" aria-label="Refresh rooms" title="Refresh rooms">↻</button></div>
            <div id="mp-rooms" role="list" aria-live="polite"></div>
          </section>
        </div>
      </div>
      <div id="mp-lobby" style="display:none">
        <div class="mp-title">ROOM <span id="mp-code"></span></div>
        <div id="mp-roster"></div>
        <div class="mp-actions"><button id="mp-ct">JOIN CT</button><button id="mp-t">JOIN T</button><button id="mp-start">START MATCH</button><button id="mp-leave">LEAVE</button></div>
        <div id="mp-lobby-status"></div>
      </div>`;
    const syncOverlay = document.createElement('div');
    syncOverlay.id = 'mp-sync-overlay';
    syncOverlay.setAttribute('role', 'status');
    syncOverlay.setAttribute('aria-live', 'assertive');
    syncOverlay.innerHTML = '<div class="mp-sync-card"><i aria-hidden="true"></i>' +
      '<strong id="mp-sync-title">RECONNECTING</strong>' +
      '<span id="mp-sync-detail">Synchronizing the latest match state…</span></div>';
    const style = document.createElement('style');
    style.textContent = `
      #hud #mp-panel { width:min(920px,94vw); padding:14px 18px; margin-top:4px; border:1px solid rgba(154,178,107,.35); background:linear-gradient(160deg,rgba(17,23,11,.94),rgba(4,7,4,.92)); pointer-events:auto; }
      #hud #mp-panel .mp-connect-grid { display:grid; grid-template-columns:minmax(280px,.82fr) minmax(420px,1.18fr); gap:18px; align-items:stretch; }
      #hud #mp-panel .mp-create-side { min-width:0; display:flex; flex-direction:column; justify-content:center; padding-right:18px; border-right:1px solid rgba(154,178,107,.18); }
      #hud #mp-panel .mp-title { display:flex; align-items:baseline; justify-content:space-between; gap:12px; color:#cfe0b8; font-size:13px; font-weight:900; letter-spacing:2px; margin-bottom:8px; }
      #hud #mp-panel .mp-title small { color:#82956b; font-size:9px; letter-spacing:.13em; white-space:nowrap; }
      #hud #mp-panel .mp-field-label { margin:0 0 -2px; color:#82956b; font-size:9px; font-weight:900; letter-spacing:.18em; }
      .mp-row,.mp-actions { display:flex; gap:8px; margin:7px 0; }
      #mp-panel input,#mp-panel select,#mp-panel button { border:1px solid rgba(154,178,107,.4); background:#0c1209; color:#cfe0b8; padding:8px 10px; font:700 12px Arial,sans-serif; letter-spacing:.5px; }
      #mp-panel input { min-width:0; flex:1; text-transform:uppercase; }
      #mp-name { text-transform:none!important; }
      #mp-panel select { flex:1; }
      #mp-panel button { cursor:pointer; flex:1; }
      #mp-panel button:hover { background:#27331a; }
      #mp-panel button:disabled { cursor:not-allowed; opacity:.48; }
      #mp-status,#mp-lobby-status { min-height:17px; color:#9ab26b; font-size:11px; letter-spacing:.06em; }
      #mp-status.error,#mp-lobby-status.error { color:#e26755; }
      #mp-roster { display:grid; grid-template-columns:1fr 1fr; gap:4px 14px; color:#dce7cf; font:700 12px Arial,sans-serif; margin:8px 0; }
      .mp-player { display:flex; justify-content:space-between; padding:4px 6px; background:rgba(154,178,107,.08); }
      .mp-player.ct span:last-child { color:#72a7e8; }.mp-player.t span:last-child { color:#e29c55; }
      #mp-start { display:none; color:#fff!important; background:#526b2e!important; }
      #hud #mp-panel .mp-directory { min-width:0; display:flex; flex-direction:column; }
      #hud #mp-panel .mp-directory-head { display:flex; align-items:center; justify-content:space-between; min-height:30px; margin-bottom:6px; }
      #hud #mp-panel .mp-directory-head > div { display:flex; align-items:baseline; gap:10px; }
      #hud #mp-panel .mp-directory-head span { color:#dfeacc; font-size:12px; font-weight:900; letter-spacing:.21em; }
      #hud #mp-panel .mp-directory-head small { color:#86986f; font-size:9px; font-weight:900; letter-spacing:.12em; }
      #hud #mp-panel #mp-refresh { flex:0 0 30px; width:30px; height:28px; padding:0; font-size:18px; line-height:1; }
      #hud #mp-panel #mp-refresh.loading { animation:mp-spin .85s linear infinite; }
      #hud #mp-panel #mp-rooms { min-height:104px; max-height:158px; overflow:auto; display:flex; flex-direction:column; gap:5px; padding-right:3px; scrollbar-width:thin; scrollbar-color:rgba(154,178,107,.38) rgba(0,0,0,.2); }
      #hud #mp-panel .mp-room-card { --room-a:#9ab26b;--room-b:#53663b;--room-c:#10160d; flex:0 0 auto; min-width:0; min-height:48px; display:grid; grid-template-columns:42px minmax(118px,1fr) 104px 58px; align-items:center; gap:9px; padding:0 8px 0 0; text-align:left; clip-path:none; border-color:rgba(154,178,107,.19); background:linear-gradient(90deg,color-mix(in srgb,var(--room-b) 25%,#090d07),rgba(7,11,6,.95) 52%); }
      #hud #mp-panel .mp-room-card:hover { border-color:var(--room-a); background:linear-gradient(90deg,color-mix(in srgb,var(--room-b) 38%,#0a1008),rgba(19,27,13,.97)); }
      #hud #mp-panel .mp-room-card.unavailable { filter:saturate(.35); }
      #hud #mp-panel .mp-room-art { align-self:stretch; position:relative; overflow:hidden; background:radial-gradient(circle at 70% 25%,var(--room-a),transparent 38%),linear-gradient(145deg,var(--room-b),var(--room-c)); }
      #hud #mp-panel .mp-room-art::after { content:''; position:absolute; inset:0; background:repeating-linear-gradient(115deg,transparent 0 8px,rgba(255,255,255,.055) 9px 10px); }
      #hud #mp-panel .mp-room-art i { position:absolute; left:5px; right:-9px; bottom:-6px; height:27px; transform:skewX(-12deg); background:var(--room-c); opacity:.78; }
      #hud #mp-panel .mp-room-copy,#hud #mp-panel .mp-room-phase,#hud #mp-panel .mp-room-count { min-width:0; display:flex; flex-direction:column; }
      #hud #mp-panel .mp-room-copy strong { overflow:hidden; text-overflow:ellipsis; color:#eef4e5; font-size:14px; letter-spacing:.13em; }
      #hud #mp-panel .mp-room-copy small { margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#96a683; font-size:9px; letter-spacing:.04em; }
      #hud #mp-panel .mp-room-phase { padding-left:9px; border-left:1px solid rgba(154,178,107,.13); }
      #hud #mp-panel .mp-room-phase b { color:var(--room-a); font-size:10px; letter-spacing:.1em; }
      #hud #mp-panel .mp-room-phase small { margin-top:3px; color:#8b9c76; font-size:9px; letter-spacing:.04em; }
      #hud #mp-panel .mp-room-count { align-items:flex-end; font-variant-numeric:tabular-nums; }
      #hud #mp-panel .mp-room-count strong { color:#e8f0dc; font-size:17px; letter-spacing:.02em; }
      #hud #mp-panel .mp-room-count strong > small { color:#d8a466; font-size:9px; vertical-align:top; }
      #hud #mp-panel .mp-room-count em { color:#8b9b78; font-size:11px; font-style:normal; }
      #hud #mp-panel .mp-room-count > small { color:#8b9c76; font-size:9px; letter-spacing:.08em; }
      #hud #mp-panel .mp-room-state { min-height:100px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; border:1px dashed rgba(154,178,107,.17); color:#8fa477; }
      #hud #mp-panel .mp-room-state i { width:16px; height:16px; margin-bottom:3px; border:2px solid rgba(154,178,107,.18); border-top-color:#9ab26b; border-radius:50%; animation:mp-spin .85s linear infinite; }
      #hud #mp-panel .mp-room-state b { font-size:17px; color:#9ab26b; }
      #hud #mp-panel .mp-room-state strong { font-size:10px; letter-spacing:.16em; }
      #hud #mp-panel .mp-room-state small { color:#879873; font-size:9px; letter-spacing:.04em; }
      #hud #mp-panel .mp-room-state.error b { color:#d76c58; }
      #mp-sync-overlay { position:absolute; inset:0; z-index:70; display:none; align-items:center; justify-content:center;
        padding:max(18px,env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) max(18px,env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left));
        background:rgba(3,6,2,.76); backdrop-filter:blur(8px); pointer-events:auto; touch-action:none; }
      .mp-sync-card { width:min(520px,92vw); padding:24px 28px; display:grid; justify-items:center; gap:10px;
        border:1px solid rgba(184,218,123,.65); background:linear-gradient(160deg,rgba(23,31,14,.97),rgba(6,9,4,.97));
        box-shadow:0 18px 60px rgba(0,0,0,.62),inset 0 0 24px rgba(154,178,107,.08); text-align:center; }
      .mp-sync-card i { width:28px; height:28px; border:3px solid rgba(154,178,107,.22); border-top-color:#c8e59a; border-radius:50%; animation:mp-spin .75s linear infinite; }
      .mp-sync-card strong { color:#eff9de; font-size:20px; font-weight:900; letter-spacing:.24em; }
      .mp-sync-card span { color:#aabd8d; font-size:12px; font-weight:700; letter-spacing:.08em; line-height:1.5; }
      @keyframes mp-spin { to { transform:rotate(360deg); } }
      @media(max-width:760px) {
        #hud #mp-panel .mp-connect-grid { grid-template-columns:1fr; gap:11px; }
        #hud #mp-panel .mp-create-side { padding-right:0; padding-bottom:10px; border-right:0; border-bottom:1px solid rgba(154,178,107,.18); }
        #hud #mp-panel #mp-rooms { max-height:170px; }
      }
      @media(max-width:480px) {
        #hud #mp-panel { padding-inline:12px; }
        #hud #mp-panel .mp-room-card { grid-template-columns:36px minmax(100px,1fr) 54px; }
        #hud #mp-panel .mp-room-phase { display:none; }
        #hud #mp-panel .mp-title small { display:none; }
      }
    `;
    menu.insertBefore(panel, menu.querySelector('.mn-controls'));
    this.game.hudRoot.appendChild(style);
    this.game.hudRoot.appendChild(syncOverlay);
    this._ui = {
      panel,
      connect: panel.querySelector('#mp-connect'),
      lobby: panel.querySelector('#mp-lobby'),
      name: panel.querySelector('#mp-name'),
      mode: panel.querySelector('#mp-mode'),
      room: panel.querySelector('#mp-room'),
      status: panel.querySelector('#mp-status'),
      lobbyStatus: panel.querySelector('#mp-lobby-status'),
      roster: panel.querySelector('#mp-roster'),
      code: panel.querySelector('#mp-code'),
      start: panel.querySelector('#mp-start'),
      rooms: panel.querySelector('#mp-rooms'),
      roomsMeta: panel.querySelector('#mp-rooms-meta'),
      refresh: panel.querySelector('#mp-refresh'),
      syncOverlay,
      syncTitle: syncOverlay.querySelector('#mp-sync-title'),
      syncDetail: syncOverlay.querySelector('#mp-sync-detail'),
    };
    panel.querySelector('#mp-create').addEventListener('click', () => this.connect('create'));
    panel.querySelector('#mp-join').addEventListener('click', () => this.connect('join'));
    panel.querySelector('#mp-ct').addEventListener('click', () => this.setTeam('ct'));
    panel.querySelector('#mp-t').addEventListener('click', () => this.setTeam('t'));
    panel.querySelector('#mp-leave').addEventListener('click', () => this.leaveRoomAndReturn());
    this._ui.start.addEventListener('click', () => this.startMatch());
    this._ui.refresh.addEventListener('click', () => this.refreshRooms());
    this._ui.room.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.connect('join');
    });
  }

  _renderLobby() {
    if (!this._ui || !this._ui.roster) return;
    this._ui.code.textContent = `${this.roomCode} · ${this.mode === 'humans' ? 'HUMANS ONLY' : 'HUMANS + BOTS'} · ${mapById(this.mapId).name.toUpperCase()}`;
    this._ui.mode.value = this.mode;
    this._ui.mode.disabled = !this.isHost;
    this._ui.mode.onchange = () => this._send({ type: 'set_mode', mode: this._ui.mode.value });
    this._ui.roster.innerHTML = this.roster.map((p) => {
      const unranked = !this.isRankedParticipant() && p.id === this.localId ? ' · UNRANKED' : '';
      return `<div class="mp-player ${p.team}"><span>${String(p.name).replace(/[<&]/g, '')}${p.host ? ' ★' : ''}${unranked}</span><span>${p.team.toUpperCase()}</span></div>`;
    }).join('');
    this._ui.start.style.display = this.isHost ? 'block' : 'none';
    const roomStatus = this.isHost
      ? 'You are host. Start when the teams are ready.'
      : 'Waiting for the host to start.';
    this._status(roomStatus + (!this.isRankedParticipant()
      ? (this._unrankedIdentityConflict
          ? ' This window is unranked; your other window keeps leaderboard credit.'
          : ' This room seat is unranked while leaderboard identity is unavailable.')
      : ''));
  }

  _status(text, error = false) {
    if (!this._ui || !this._ui.status) return;
    for (const element of [this._ui.status, this._ui.lobbyStatus]) {
      if (!element) continue;
      element.textContent = text;
      element.classList.toggle('error', error);
    }
  }

  _commitPendingProfile() {
    const pending = this._pendingProfile;
    this._pendingProfile = null;
    if (!pending || this._unrankedIdentityConflict) return;
    if (this.game.profile && typeof this.game.profile.update === 'function') {
      this.game.profile.update(pending);
      return;
    }
    if (this.game.leaderboard && typeof this.game.leaderboard.setPlayerName === 'function') {
      this.game.leaderboard.setPlayerName(pending.name);
      return;
    }
    try {
      localStorage.setItem('tiny-strike-player-name', pending.name);
      localStorage.setItem('goldeneye-name', pending.name); // migration compatibility
    } catch { /* private mode */ }
  }
}
