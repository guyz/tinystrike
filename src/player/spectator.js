// CS-style above-the-operator death spectating for TINY STRIKE.
//
// Target discovery and cycling are exported separately so roster behavior can
// be covered without constructing Three.js cameras or browser input objects.

const MATCH_PHASES = new Set(['freeze', 'live', 'planted', 'roundEnd']);
const CAMERA_FORWARD_OFFSET = 0.07;
const CAMERA_VISUAL_CLEARANCE = 0.22;
const REMOTE_HEADGEAR_EXTRA = 0.20;
const REMOTE_CROUCH_ROOT_DROP = 0.25;
const BOT_CROUCH_VISUAL_SCALE = 0.80;
const PITCH_LIMIT = 1.45;

function finitePosition(actor) {
  const pos = actor && (actor.position || actor.pos);
  return pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)
    ? pos
    : null;
}

function addCandidate(out, seen, actor, descriptor) {
  if (!actor || actor.alive === false || !finitePosition(actor)) return;
  if (!descriptor.id || seen.has(descriptor.id)) return;
  seen.add(descriptor.id);
  out.push({ ...descriptor, actor });
}

/**
 * Returns living same-team actors in a stable order: humans first, then bots.
 * Opponents are intentionally excluded during live play so spectating cannot
 * leak enemy positions to teammates in a multiplayer room.
 */
export function collectSpectatorCandidates(game, localPlayer) {
  const result = [];
  const seen = new Set();
  const team = localPlayer && localPlayer.team;
  if (!game || !localPlayer || !team) return result;

  const mp = game.multiplayer;
  if (mp && mp.active && Array.isArray(mp.remotePlayers)) {
    for (const actor of mp.remotePlayers) {
      if (!actor || actor === localPlayer || actor.team !== team) continue;
      addCandidate(result, seen, actor, {
        id: `human:${actor.networkId || actor.name || result.length}`,
        name: actor.name || 'Teammate',
        team: actor.team,
        kind: 'human',
      });
    }
  }

  const bots = game.bots && Array.isArray(game.bots.all) ? game.bots.all : [];
  for (let i = 0; i < bots.length; i++) {
    const actor = bots[i];
    if (!actor || actor.team !== team) continue;
    addCandidate(result, seen, actor, {
      id: `bot:${actor.team}:${Number.isFinite(actor.slot) ? actor.slot : i}`,
      name: actor.name || `Bot ${i + 1}`,
      team: actor.team,
      kind: 'bot',
    });
  }

  return result;
}

/** Select the current target, or move by `step` with wraparound. */
export function selectSpectatorCandidate(candidates, currentId, step = 0) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const index = candidates.findIndex((candidate) => candidate.id === currentId);
  if (step === 0) return index >= 0 ? candidates[index] : candidates[0];
  if (index < 0) return step < 0 ? candidates[candidates.length - 1] : candidates[0];
  const wrapped = ((index + step) % candidates.length + candidates.length) % candidates.length;
  return candidates[wrapped];
}

/**
 * Height of the CS-style spectator hover camera above an actor's feet.
 *
 * Gameplay eye heights are deliberately not used here: they sit inside the
 * rendered head (and, while crouched, can fall into the neck or torso). The
 * observer instead rides just above the visible silhouette. Remote-player
 * models include headgear above their collision capsule and lower their whole
 * render root while crouching; bot crouch animations compact the silhouette.
 */
export function spectatorHoverHeight(actor, kind = 'bot', config = {}) {
  const explicitTop = Number(actor && actor.spectatorVisualTop);
  if (Number.isFinite(explicitTop) && explicitTop > 0) {
    return explicitTop + CAMERA_VISUAL_CLEARANCE;
  }

  const crouching = !!(actor && actor.crouching);
  if (kind === 'human') {
    const playerCfg = config.PLAYER || {};
    const standingTop = (Number(playerCfg.HEIGHT_STAND) || 1.83) + REMOTE_HEADGEAR_EXTRA;
    return standingTop - (crouching ? REMOTE_CROUCH_ROOT_DROP : 0) + CAMERA_VISUAL_CLEARANCE;
  }

  const botCfg = config.BOT || {};
  const standingTop = Number(botCfg.HEIGHT) || 1.83;
  const visualTop = crouching ? standingTop * BOT_CROUCH_VISUAL_SCALE : standingTop;
  return visualTop + CAMERA_VISUAL_CLEARANCE;
}

export class SpectatorCamera {
  constructor(game, localPlayer) {
    this.game = game;
    this.localPlayer = localPlayer;
    this.targetId = null;
    this.target = null;
    this._payload = null;
  }

  /** Public read-only-by-convention HUD/network-friendly target descriptor. */
  current() {
    return this._payload;
  }

  reset() {
    if (!this.targetId && !this._payload) return;
    this.targetId = null;
    this.target = null;
    this._payload = null;
    this.localPlayer.spectatorTarget = null;
    this._emitTarget(null);
  }

  cycle() {
    const candidates = collectSpectatorCandidates(this.game, this.localPlayer);
    this._setTarget(selectSpectatorCandidate(candidates, this.targetId, 1));
    return this.target;
  }

  /**
   * Updates the observer camera. Returns true when a living target owns the
   * camera; false tells Player to retain its static death camera fallback.
   */
  update() {
    const phase = this.game && this.game.state && this.game.state.phase;
    if (this.localPlayer.alive !== false || !MATCH_PHASES.has(phase)) {
      this.reset();
      return false;
    }

    const input = this.game.input;
    const cyclePressed = !!(input && typeof input.wasPressed === 'function' && input.wasPressed(' '));
    const candidates = collectSpectatorCandidates(this.game, this.localPlayer);
    const next = selectSpectatorCandidate(candidates, this.targetId, cyclePressed ? 1 : 0);
    this._setTarget(next);

    // Spectator aim is driven by the observed actor, never by stale local
    // mouse movement. Flushing also prevents a look snap on round respawn.
    if (input && typeof input.consumeLook === 'function') input.consumeLook();

    if (!this.target || this.target.alive === false) return false;
    return this._applyCamera(this.target);
  }

  _setTarget(candidate) {
    if (!candidate) {
      if (this.targetId || this._payload) this.reset();
      return;
    }

    // The actor object can be replaced when a roster is rebuilt even if its
    // stable id stays the same, so always refresh the live actor reference.
    this.target = candidate.actor;
    if (candidate.id === this.targetId) return;

    this.targetId = candidate.id;
    this._payload = {
      id: candidate.id,
      name: candidate.name,
      team: candidate.team,
      kind: candidate.kind,
    };
    this.localPlayer.spectatorTarget = this._payload;
    this._emitTarget(this._payload);
  }

  _emitTarget(target) {
    const events = this.game && this.game.events;
    if (events && typeof events.emit === 'function') events.emit('spectator:target', { target });
  }

  _applyCamera(actor) {
    const camera = this.game.camera;
    const pos = finitePosition(actor);
    if (!camera || !pos) return false;

    const kind = this._payload && this._payload.kind === 'human' ? 'human' : 'bot';
    const hoverHeight = spectatorHoverHeight(actor, kind, this.game.config || {});
    const yaw = Number.isFinite(actor.yaw) ? actor.yaw : 0;
    const rawPitch = kind === 'bot' ? actor.aimPitch : actor.pitch;
    const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, Number(rawPitch) || 0));

    // Ride above the visible silhouette instead of inside its gameplay eye.
    // The small forward bias keeps the view direction intuitive without
    // turning this into a trailing third-person camera or pushing through walls.
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    camera.position.set(
      pos.x + forwardX * CAMERA_FORWARD_OFFSET,
      pos.y + hoverHeight,
      pos.z + forwardZ * CAMERA_FORWARD_OFFSET
    );
    if (camera.rotation.order !== 'YXZ') camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    camera.rotation.z = 0;
    return true;
  }
}
