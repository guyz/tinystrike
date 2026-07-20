import * as THREE from 'three';
import { mapById, normalizeMapId } from '../maps/catalog.js';
import {
  getCharacterPalette,
  normalizeCharacterId,
  normalizePlayerName,
} from '../player/profile.js';
import { resolveWebSocketEndpoint } from './endpoints.js';

const SEND_HZ = 20;
const SNAPSHOT_HZ = 12;
const TEAM_SIZE = 5;
const MAX_RECONNECT_ATTEMPTS = 10;
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
    this._buildUI();
    this._bindEvents();
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

  async connect(action) {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    const name = safeName(this._ui.name.value);
    const characterId = normalizeCharacterId(this.game.profile?.characterId);
    const room = this._ui.room.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const mode = this._ui.mode.value === 'humans' ? 'humans' : 'mixed';
    if (action === 'join' && !room) {
      this._status('Enter a room code to join.', true);
      return;
    }
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
      return;
    }

    let socket;
    try {
      socket = new WebSocket(endpoint);
    } catch {
      if (reconnecting) this._scheduleReconnect();
      else this._status('Could not reach the online service.', true);
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
      if (this.localId && this.roomCode && this.reconnectToken) {
        this._scheduleReconnect();
      } else {
        this._showDisconnected();
      }
    });
    socket.addEventListener('error', () => {
      if (!reconnecting) this._status('Could not reach the online service.', true);
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
        this.localId = message.id;
        this.hostId = message.hostId;
        this.roomCode = message.room;
        this.mode = message.mode;
        this.reconnectToken = String(message.reconnectToken || this.reconnectToken || '');
        this._reconnectAttempts = 0;
        this._reconnecting = false;
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
        this._status('Room joined. Choose a side and wait for the host.');
        break;
      case 'lobby':
        this.hostId = message.hostId;
        this.isHost = this.localId === this.hostId;
        this.mode = message.mode;
        this._applyRoomMap(message.mapId);
        this.roster = Array.isArray(message.players) ? message.players : [];
        this._renderLobby();
        break;
      case 'match_start':
        this._beginMatch(message);
        break;
      case 'match_resume':
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

  _beginMatch(message) {
    this._applyRoomMap(message.mapId);
    this.active = true;
    this.matchId = message.matchId || null;
    this.mode = message.mode === 'humans' ? 'humans' : 'mixed';
    this.hostId = message.hostId;
    this.isHost = this.localId === this.hostId;
    this.roster = Array.isArray(message.players) ? message.players : [];
    const mine = this.roster.find((p) => p.id === this.localId);
    if (!mine) return;

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

    const counts = { ct: 0, t: 0 };
    for (const p of this.roster) counts[p.team]++;
    const botCounts = this.mode === 'mixed'
      ? { ct: Math.max(0, TEAM_SIZE - counts.ct), t: Math.max(0, TEAM_SIZE - counts.t) }
      : { ct: 0, t: 0 };
    if (this.game.bots && typeof this.game.bots.configureRoster === 'function') {
      this.game.bots.configureRoster(botCounts.ct, botCounts.t);
    }

    this._ui.panel.style.display = 'none';
    this.game.events.emit('network:match-start', {
      mode: this.mode,
      roster: this.roster,
      botCounts,
      localId: this.localId,
      hostId: this.hostId,
    });
    this.game.events.emit('ui:start');
    if (this.game.input && typeof this.game.input.requestLock === 'function') this.game.input.requestLock();
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
      alive: true,
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

  _applyRemoteAppearance(remote, characterId) {
    if (!remote) return;
    const nextId = normalizeCharacterId(characterId);
    if (nextId === remote.characterId) return;
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
    if (remote.mesh) this.game.scene.remove(remote.mesh);
    this._remoteById.delete(id);
    const index = this.remotePlayers.indexOf(remote);
    if (index >= 0) this.remotePlayers.splice(index, 1);
    this.roster = this.roster.filter((p) => p.id !== id);
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
        <div class="mp-title">ONLINE PLAY</div>
        <div class="mp-row"><input id="mp-name" maxlength="20" value="${savedName.replace(/[<&\"]/g, '')}" placeholder="Callsign"></div>
        <div class="mp-row">
          <select id="mp-mode"><option value="mixed">HUMANS + BOTS</option><option value="humans">HUMANS ONLY</option></select>
          <input id="mp-room" maxlength="6" placeholder="ROOM CODE">
        </div>
        <div class="mp-actions"><button id="mp-create">CREATE ROOM</button><button id="mp-join">JOIN ROOM</button></div>
      </div>
      <div id="mp-lobby" style="display:none">
        <div class="mp-title">ROOM <span id="mp-code"></span></div>
        <div id="mp-roster"></div>
        <div class="mp-actions"><button id="mp-ct">JOIN CT</button><button id="mp-t">JOIN T</button><button id="mp-start">START MATCH</button><button id="mp-leave">LEAVE</button></div>
      </div>
      <div id="mp-status">Create a room, or enter a code to join one.</div>`;
    const style = document.createElement('style');
    style.textContent = `
      #mp-panel { width:min(620px,88vw); padding:14px 18px; margin-top:14px; border:1px solid rgba(154,178,107,.35); background:rgba(5,8,4,.72); pointer-events:auto; }
      .mp-title { color:#cfe0b8; font-size:13px; font-weight:900; letter-spacing:2px; margin-bottom:8px; }
      .mp-row,.mp-actions { display:flex; gap:8px; margin:7px 0; }
      #mp-panel input,#mp-panel select,#mp-panel button { border:1px solid rgba(154,178,107,.4); background:#0c1209; color:#cfe0b8; padding:8px 10px; font:700 12px Arial,sans-serif; letter-spacing:.5px; }
      #mp-panel input { min-width:0; flex:1; text-transform:uppercase; }
      #mp-name { text-transform:none!important; }
      #mp-panel select { flex:1; }
      #mp-panel button { cursor:pointer; flex:1; }
      #mp-panel button:hover { background:#27331a; }
      #mp-status { min-height:16px; color:#9ab26b; font-size:11px; letter-spacing:.5px; }
      #mp-status.error { color:#e26755; }
      #mp-roster { display:grid; grid-template-columns:1fr 1fr; gap:4px 14px; color:#dce7cf; font:700 12px Arial,sans-serif; margin:8px 0; }
      .mp-player { display:flex; justify-content:space-between; padding:4px 6px; background:rgba(154,178,107,.08); }
      .mp-player.ct span:last-child { color:#72a7e8; }.mp-player.t span:last-child { color:#e29c55; }
      #mp-start { display:none; color:#fff!important; background:#526b2e!important; }
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
      roster: panel.querySelector('#mp-roster'),
      code: panel.querySelector('#mp-code'),
      start: panel.querySelector('#mp-start'),
    };
    panel.querySelector('#mp-create').addEventListener('click', () => this.connect('create'));
    panel.querySelector('#mp-join').addEventListener('click', () => this.connect('join'));
    panel.querySelector('#mp-ct').addEventListener('click', () => this.setTeam('ct'));
    panel.querySelector('#mp-t').addEventListener('click', () => this.setTeam('t'));
    panel.querySelector('#mp-leave').addEventListener('click', () => location.reload());
    this._ui.start.addEventListener('click', () => this.startMatch());
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
    this._ui.status.textContent = text;
    this._ui.status.classList.toggle('error', error);
  }
}
