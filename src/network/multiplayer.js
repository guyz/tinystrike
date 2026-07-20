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
const EFFECT_EVENTS = [
  'fx:tracer', 'fx:impact', 'fx:blood', 'fx:explosion', 'fx:flash', 'fx:smoke', 'kill',
];

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
    this._networkEvent = false;
    this.reconnectToken = '';
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._reconnecting = false;
    this.waitingForNextRound = false;
    this.joinRound = null;
    this._pendingLiveJoin = false;
    this._botRosterPendingRound = null;
    this._connecting = false;
    this._roomDirectoryRequest = 0;
    this._roomDirectoryController = null;
    this._roomRefreshTimer = null;
    this._buildUI();
    this._bindEvents();
    this.refreshRooms();
    this._roomRefreshTimer = setInterval(() => this._refreshRoomsIfVisible(), ROOM_REFRESH_MS);
    this._roomRefreshTimer?.unref?.();
  }

  isAuthority() {
    return !this.active || this.isHost;
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
    if (!this.active || !this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    this._sendAccum += dt;
    if (this._sendAccum >= 1 / SEND_HZ) {
      this._sendAccum %= 1 / SEND_HZ;
      this._send({ type: 'player_state', state: this._localState() });
    }

    if (this.isHost) {
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
    this.localName = name;
    if (this.game.profile) this.game.profile.update({ name, characterId });
    if (this.game.leaderboard && typeof this.game.leaderboard.setPlayerName === 'function') {
      this.game.leaderboard.setPlayerName(name);
    } else {
      localStorage.setItem('tiny-strike-player-name', name);
    }
    localStorage.setItem('goldeneye-name', name); // migration compatibility
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
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      this._onMessage(message);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.connected = false;
      this.socket = null;
      this._setConnecting(false);
      if (this.localId && this.roomCode && this.reconnectToken) {
        this._scheduleReconnect();
      } else {
        this._showDisconnected();
      }
    });
    socket.addEventListener('error', () => {
      if (!reconnecting) this._status('Could not reach the online service.', true);
      if (!reconnecting) this._setConnecting(false);
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this.socket) return;
    if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this._showDisconnected();
      if (this.active) this.game.events.emit('hud:notice', { text: 'Online connection lost.' });
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
      }, true);
    }, delay);
  }

  _showDisconnected() {
    this._status('Disconnected from the room server.', true);
    if (!this.active && this._ui) {
      this._ui.connect.style.display = 'block';
      this._ui.lobby.style.display = 'none';
      const solo = this.game.hudRoot.querySelector('#hud-start');
      if (solo) solo.style.display = 'block';
      this.localId = null;
      this.reconnectToken = '';
    }
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

  applyDamageToRemote(target, amount, info = {}) {
    if (!this.active || !this.isHost || !target || !target.alive || !(amount > 0)) return;
    let healthDamage = amount;
    if (target.armor > 0) {
      healthDamage = amount * (info.headshot ? 0.85 : this.game.config.ARMOR_DAMAGE_SCALE);
      target.armor = Math.max(0, target.armor - amount * 0.5);
    }
    target.health = Math.max(0, target.health - healthDamage);
    const died = target.health <= 0;
    if (died) target.alive = false;
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
    ev.on('weapon:fire', (data) => {
      if (!this.active || this.isHost || !data || !data.origin || !data.dir) return;
      this._send({
        type: 'fire',
        weaponId: data.weaponId,
        origin: vec(data.origin),
        dir: vec(data.dir),
        melee: !!data.melee,
      });
    });
    ev.on('grenade:throw', (data) => {
      if (!this.active || this.isHost || !data || !data.origin || !data.dir) return;
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
        if (!this.active || !this.isHost || this._networkEvent || (data && data._network)) return;
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

  _onMessage(message) {
    switch (message.type) {
      case 'welcome':
        this._setConnecting(false);
        this.localId = message.id;
        this.hostId = message.hostId;
        this.roomCode = message.room;
        this.mode = message.mode;
        this.reconnectToken = String(message.reconnectToken || this.reconnectToken || '');
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
          this.isHost = this.localId === this.hostId;
          this.game.events.emit('hud:notice', { text: 'Online connection restored.' });
          break;
        }
        this._applyRoomMap(message.mapId);
        this.isHost = this.localId === this.hostId;
        this._ui.room.value = this.roomCode;
        this._ui.mode.value = this.mode;
        this._ui.connect.style.display = 'none';
        this._ui.lobby.style.display = 'block';
        const solo = this.game.hudRoot.querySelector('#hud-start');
        if (solo) solo.style.display = 'none';
        this._status(this._pendingLiveJoin
          ? `Match in progress — joining as spectator${this.joinRound ? ` until round ${this.joinRound}` : ''}.`
          : 'Room joined. Choose a side and wait for the host.');
        break;
      case 'lobby':
        this.hostId = message.hostId;
        this.isHost = this.localId === this.hostId;
        this.mode = message.mode;
        if (!this.active) this._applyRoomMap(message.mapId);
        else this.mapId = normalizeMapId(message.mapId || this.mapId);
        this.roster = Array.isArray(message.players) ? message.players : [];
        if (this.active) this._syncActiveRoster();
        else if (!this._pendingLiveJoin) this._renderLobby();
        break;
      case 'roster_update':
        this.hostId = message.hostId || this.hostId;
        this.isHost = this.localId === this.hostId;
        if (message.mode) this.mode = message.mode === 'humans' ? 'humans' : 'mixed';
        this.roster = Array.isArray(message.players) ? message.players : this.roster;
        if (this.active) this._syncActiveRoster();
        else if (!this._pendingLiveJoin) this._renderLobby();
        break;
      case 'match_start':
        this._beginMatch(message);
        break;
      case 'match_resume':
        if (!this.active && (message.lateJoin || message.spectating || this._pendingLiveJoin)) {
          this._beginMatch(message, { lateJoin: true, snapshot: message.snapshot || null });
          break;
        }
        this.matchId = message.matchId || this.matchId;
        this.hostId = message.hostId;
        this.isHost = this.localId === this.hostId;
        this.mode = message.mode === 'humans' ? 'humans' : 'mixed';
        this.mapId = normalizeMapId(message.mapId || this.mapId);
        this.roster = Array.isArray(message.players) ? message.players : this.roster;
        if (this.active) this._rebuildRemotes();
        if (!this.isHost && message.snapshot) this._applySnapshot(message.snapshot);
        if (this.active && this.isHost) this.game.events.emit('network:host', { hostId: this.hostId });
        break;
      case 'player_ready':
        this._onPlayerReady(message);
        break;
      case 'host_changed':
        this.hostId = message.hostId;
        this.isHost = this.localId === this.hostId;
        this._renderLobby();
        if (this.active && this.isHost) this.game.events.emit('network:host', { hostId: this.hostId });
        break;
      case 'player_state':
        this._applyPlayerState(message.id, message.state);
        break;
      case 'snapshot':
        if (!this.isHost) this._applySnapshot(message.snapshot);
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
      case 'error':
        this._setConnecting(false);
        this._status(message.message || 'Online error.', true);
        if (this._reconnecting && this.socket) {
          const failed = this.socket;
          this.socket = null;
          this.connected = false;
          this.reconnectToken = '';
          this._reconnecting = false;
          failed.close();
          this._showDisconnected();
          if (this.active) this.game.events.emit('hud:notice', { text: 'Online connection could not be restored.' });
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

  _beginMatch(message, options = {}) {
    const lateJoin = !!(options.lateJoin || message.lateJoin || message.spectating);
    const snapshot = options.snapshot || message.snapshot || null;
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
    if (this.game.profile) this.game.profile.update({ name: this.localName, characterId: localCharacterId });
    this.game.sessionMode = this.mode;
    this.game.player.team = mine.team;
    this.game.player.name = this.localName;
    this.game.player.characterId = localCharacterId;
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
      if (snapshot) this._applySnapshot(snapshot);
      this.game.events.emit('hud:notice', {
        text: `Joined mid-round — spectating until round ${this.joinRound || currentRound + 1}.`,
      });
      this.game.events.emit('network:waiting-for-round', {
        round: this.joinRound || currentRound + 1,
      });
    }
    if (this.game.input && typeof this.game.input.requestLock === 'function') this.game.input.requestLock();
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
        if (entry.spectating || entry.alive === false) remote.alive = false;
      }
    }
    this._queueBotRosterRebalance();
    for (const remote of [...this.remotePlayers]) {
      if (!nextIds.has(remote.networkId)) this._removeRemote(remote.networkId);
    }
    if (this.game.hud) this.game.hud._sbDirty = true;
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
    for (const remote of this.remotePlayers) if (remote.mesh) this.game.scene.remove(remote.mesh);
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
      crouching: false,
      walking: false,
      moveSpeed2D: 0,
      onGround: true,
      useDown: false,
      weaponId: entry.team === 'ct' ? 'usp' : 'glock',
      radius: this.game.config.PLAYER.RADIUS,
      height: this.game.config.PLAYER.HEIGHT_STAND,
      isRemotePlayer: true,
      mesh: null,
      hitCapsule: () => ({ pos: remote.position, radius: remote.radius, height: remote.height }),
      takeDamage: (amount, info) => this.applyDamageToRemote(remote, amount, info),
    };
    remote.mesh = this._buildRemoteMesh(remote.team, remote.characterId);
    remote.mesh.userData.remotePlayer = remote;
    remote.mesh.visible = false;
    this.game.scene.add(remote.mesh);
    return remote;
  }

  _buildRemoteMesh(team, characterId) {
    const group = new THREE.Group();
    const palette = getCharacterPalette(characterId, team);
    const uniform = new THREE.MeshStandardMaterial({ color: palette.uniform, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: palette.dark, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: palette.skin, roughness: 0.8 });
    const box = (w, h, d, y, material, parent = group) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
      mesh.position.y = y;
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };
    box(0.62, 0.78, 0.34, 1.25, uniform);
    box(0.23, 0.72, 0.25, 0.55, dark).position.x = -0.18;
    box(0.23, 0.72, 0.25, 0.55, dark).position.x = 0.18;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 9), skin);
    head.position.y = 1.78;
    head.castShadow = true;
    group.add(head);
    const headgear = new THREE.Group();
    headgear.name = 'character-headgear';
    const headgearMaterial = dark;
    if (palette.headgear === 'helmet') {
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.235, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.58), headgearMaterial);
      shell.position.y = 1.83;
      shell.scale.set(1.08, 0.72, 1.08);
      shell.castShadow = true;
      headgear.add(shell);
    } else if (palette.headgear === 'cap') {
      box(0.42, 0.10, 0.38, 1.94, headgearMaterial, headgear);
      const brim = box(0.32, 0.035, 0.20, 1.91, headgearMaterial, headgear);
      brim.position.z = -0.16;
    } else if (palette.headgear === 'wrap') {
      const wrap = box(0.47, 0.12, 0.45, 1.84, headgearMaterial, headgear);
      wrap.name = 'character-wrap';
    } else {
      const mask = new THREE.Mesh(new THREE.SphereGeometry(0.225, 12, 9), headgearMaterial);
      mask.position.y = 1.78;
      mask.scale.set(1.03, 1.03, 1.03);
      mask.castShadow = true;
      headgear.add(mask);
    }
    group.add(headgear);
    const gun = box(0.10, 0.11, 0.8, 1.30, dark);
    gun.position.z = -0.48;
    group.userData.gun = gun;
    group.userData.appearanceMaterials = { uniform, dark, skin };
    return group;
  }

  _applyRemoteAppearance(remote, characterId, force = false) {
    if (!remote) return;
    const nextId = normalizeCharacterId(characterId);
    if (!force && nextId === remote.characterId) return;
    const oldMesh = remote.mesh;
    const nextMesh = this._buildRemoteMesh(remote.team, nextId);
    nextMesh.position.copy(oldMesh.position);
    nextMesh.rotation.copy(oldMesh.rotation);
    nextMesh.visible = oldMesh.visible;
    nextMesh.userData.remotePlayer = remote;
    if (oldMesh.parent) {
      oldMesh.parent.add(nextMesh);
      oldMesh.parent.remove(oldMesh);
    }
    const oldMaterials = new Set();
    oldMesh.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry?.dispose();
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (material) oldMaterials.add(material);
      }
    });
    for (const material of oldMaterials) material.dispose();
    remote.characterId = nextId;
    remote.mesh = nextMesh;
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
    if (typeof state.alive === 'boolean') remote.alive = state.alive;
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
    remote.mesh.visible = true;
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
      remote.mesh.rotation.z = remote.alive ? 0 : Math.PI * 0.48;
      remote.mesh.position.y += remote.crouching && remote.alive ? -0.25 : 0;
      remote.mesh.visible = this.active;
    }
  }

  _localState() {
    const p = this.game.player;
    const input = this.game.input;
    return {
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
    };
  }

  _applySnapshot(snapshot) {
    if (!snapshot) return;
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
    if (snapshot.state && snapshot.state.bomb && this.game.bots &&
      typeof this.game.bots.applyObjectiveSnapshot === 'function') {
      this.game.bots.applyObjectiveSnapshot(snapshot.state.bomb);
    }
    if (!this.waitingForNextRound && remoteRound && this.joinRound && remoteRound >= this.joinRound) {
      this.joinRound = null;
    }
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
    remote.alive = result.alive !== false;
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
    if (remote.mesh) this.game.scene.remove(remote.mesh);
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
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
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
    };
    panel.querySelector('#mp-create').addEventListener('click', () => this.connect('create'));
    panel.querySelector('#mp-join').addEventListener('click', () => this.connect('join'));
    panel.querySelector('#mp-ct').addEventListener('click', () => this.setTeam('ct'));
    panel.querySelector('#mp-t').addEventListener('click', () => this.setTeam('t'));
    panel.querySelector('#mp-leave').addEventListener('click', () => location.reload());
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
    this._ui.roster.innerHTML = this.roster.map((p) =>
      `<div class="mp-player ${p.team}"><span>${String(p.name).replace(/[<&]/g, '')}${p.host ? ' ★' : ''}</span><span>${p.team.toUpperCase()}</span></div>`
    ).join('');
    this._ui.start.style.display = this.isHost ? 'block' : 'none';
    this._status(this.isHost ? 'You are host. Start when the teams are ready.' : 'Waiting for the host to start.');
  }

  _status(text, error = false) {
    if (!this._ui || !this._ui.status) return;
    for (const element of [this._ui.status, this._ui.lobbyStatus]) {
      if (!element) continue;
      element.textContent = text;
      element.classList.toggle('error', error);
    }
  }
}
