// ============================================================================
// TINY STRIKE — src/game/rounds.js
//
// Section H: Match flow + economy + bomb + objectives.
//
// This module OWNS all mutations of:
//   game.state.phase / timer / round / scores / money / bomb / canBuy
// (combat is additionally allowed to add money on kills, per spec).
//
// Phase machine:
//   'menu' -> ('ui:start' | debug auto-start) -> 'freeze' -> 'live'
//   'live'    : eliminations / time expiry / 'bomb:planted'
//   'planted' : eliminations (T immediate) / player E-hold defuse /
//               'bomb:defused' (bots) / fuse expiry -> detonation
//   'roundEnd': ROUND_END_TIME slack -> next round or 'gameEnd'
//   'gameEnd' : waits for 'ui:restart' -> full match reset -> round 1
//
// Win conditions (exactly as specced):
//   - All Ts dead        -> CT win 'elimination' — UNLESS the bomb is planted:
//                           a planted bomb must still be defused (CS rule).
//   - All CTs dead       -> T win 'elimination' — immediate, even mid-plant.
//     (player counts toward CT alive)
//   - 'live' timer == 0  -> CT win 'time' (bomb not planted by definition).
//   - 'planted' timer==0 -> detonation: emit 'bomb:detonated' {pos} (combat
//                           applies radial damage) + 'fx:explosion'
//                           {pos, radius:16} (visual/audio) -> T win 'bomb'.
//   - Bomb defused       -> CT win 'defuse' (by a CT bot or the player).
//
// Economy (player money — game.state.money):
//   - Win: +WIN_REWARD. Loss: +min(LOSS_BASE + LOSS_STEP*(streak-1), LOSS_MAX)
//     with the consecutive-loss streak resetting on a win.
//   - Player defuse: +DEFUSE_REWARD on top of the round win.
//   - Clamped to [0, MAX_MONEY]. (Kill rewards are combat's job.)
//
// Also owns the physical C4 prop: a small olive charge with keypad, LCD,
// wires and a red LED that blinks on the same accelerating cadence the audio
// module uses for beeps ( interval = clamp(timer/40, 0.12, 1) s ).
// ============================================================================

import * as THREE from 'three';

// --- Tuning local to this module (everything match-critical is in CONFIG) ---
const MENU_AUTOSTART_DELAY = 0.5; // s, debug (?test) auto-start
const BUY_ZONE_RADIUS = 12;       // m from own spawn, buying allowed early live
const BUY_WINDOW_LIVE = 20;       // s of 'live' during which buying is allowed
const DEFUSE_RANGE = 1.6;         // m from bomb to defuse
const DEFUSE_MOVE_EPS = 0.6;      // m/s — moving faster than this resets defuse
const PLANT_MOVE_EPS = 0.7;       // m/s — planting requires holding still
const DETONATION_RADIUS = 16;     // m, bomb blast (combat reads its own value
                                  //    off the fx:explosion payload)
const LED_ON_TIME = 0.07;         // s the LED stays lit per blink
const BOT_DEFUSE_STALE = 1.5;     // s without refresh before we clear a bot's
                                  //    'defusingBy' tag (bots emit no cancel)
const NETWORK_TIMED_PHASES = new Set(['freeze', 'live', 'planted', 'roundEnd']);

const _scratchA = new THREE.Vector3();
const _scratchB = new THREE.Vector3();

export default class Rounds {
  constructor(game) {
    this.game = game;

    const s = game.state;
    s.phase = 'menu';
    s.timer = 0;
    s.canBuy = false;

    // --- match / round bookkeeping ---------------------------------------
    this._matchStarted = false;
    this._matchWinner = null;      // set once a side reaches WIN_ROUNDS
    this._lastRoundResult = null;  // replicated to non-host clients
    this._lossStreak = 0;          // consecutive CT (player-team) losses
    this._economyRound = 0;        // last round reward applied to local money
    this._playerDiedThisRound = false;
    this._liveElapsed = 0;         // seconds since 'live' began (buy window)
    this._menuT = 0;               // debug auto-start accumulator
    this._time = 0;                // module-local clock for cosmetic wobble

    // --- defuse bookkeeping ----------------------------------------------
    this._defuseEmitted = false;   // guard: emit 'bomb:defused' once
    this._lastDefuser = null;      // 'player' | bot name | null
    this._lastDefuserId = null;
    this._botDefuseTimer = 0;      // stale-out for bot 'defusingBy' tag
    this._plantProgress = 0;

    // --- player spawn (for the live-phase buy zone) ----------------------
    this._playerSpawnPos = new THREE.Vector3();
    this._hasPlayerSpawn = false;

    // --- one-shot anomaly warnings (rule 10: no spam) --------------------
    this._warnedNoSpawn = false;
    this._warnedPlantPhase = false;

    // --- bomb prop ---------------------------------------------------------
    this._bombPos = new THREE.Vector3(); // authoritative planted position
    this._bombGroup = null;        // built lazily on first plant
    this._bombLedMat = null;
    this._bombScreenMat = null;
    this._bombLight = null;
    this._bombInScene = false;
    this._bombDefusedVisual = false;
    this._blinkT = 0;              // time since last blink
    this._ledOnT = 0;              // time LED has been lit
    this._ledOn = false;
    // If the round ends by T elimination while the bomb is still armed, the
    // fuse keeps ticking cosmetically through roundEnd/gameEnd and pops a
    // purely audiovisual fx:explosion (no bomb:detonated -> no damage).
    this._cosmeticArmed = false;
    this._cosmeticFuse = 0;

    // --- events -----------------------------------------------------------
    const ev = game.events;
    ev.on('ui:start', () => this._onUiStart());
    ev.on('ui:restart', () => this._onUiRestart());
    ev.on('bomb:planted', (p) => this._onBombPlanted(p));
    ev.on('bomb:defused', (p) => this._onBombDefused(p));
    ev.on('bot:defusing', (p) => this._onBotDefusing(p));
    ev.on('player:death', () => { this._playerDiedThisRound = true; });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /** Buying allowed right now? (mirror of game.state.canBuy, set each frame) */
  canBuy() {
    return !!this.game.state.canBuy;
  }

  lastRoundResult() {
    return this._lastRoundResult;
  }

  /** Apply the authoritative host's phase/objective state on a non-host client. */
  applyNetworkSnapshot(remote) {
    const mp = this.game.multiplayer;
    if (!remote || !mp || !mp.active || mp.isAuthority()) return;
    const s = this.game.state;
    const previousPhase = s.phase;
    const previousRound = s.round;

    if (Number.isFinite(remote.round) && remote.round > previousRound) {
      const died = !this.game.player.alive;
      s.round = remote.round;
      this._resetBombState();
      const spawn = this._pickPlayerSpawn(this.game.player.team, mp.localTeamIndex());
      this.game.player.resetForRound(spawn);
      if (died) this.game.player.hasKit = false;
      if (this.game.weapons && typeof this.game.weapons.resetForRound === 'function') {
        this.game.weapons.resetForRound({ died });
      }
      this._playerDiedThisRound = false;
      this.game.events.emit('round:start', { round: s.round });
    } else if (Number.isFinite(remote.round)) {
      s.round = remote.round;
    }

    if (remote.scores) {
      s.scores.ct = Number(remote.scores.ct) || 0;
      s.scores.t = Number(remote.scores.t) || 0;
    }
    if (Number.isFinite(remote.timer)) s.timer = remote.timer;
    s.canBuy = !!remote.canBuy;

    const rb = remote.bomb || {};
    s.bomb.planted = !!rb.planted;
    s.bomb.site = rb.site || null;
    s.bomb.defusingBy = rb.defusingBy || null;
    s.bomb.defuseProgress = Number(rb.defuseProgress) || 0;
    s.bomb.defuseTime = Number(rb.defuseTime) || this.game.config.MATCH.DEFUSE_TIME;
    s.bomb.plantProgress = Number(rb.plantProgress) || 0;
    s.bomb.plantTime = Number(rb.plantTime) || this.game.config.MATCH.PLANT_TIME;
    this._plantProgress = s.bomb.plantProgress;
    s.bomb.carrierId = rb.carrierId || null;
    if (rb.pos) {
      this._bombPos.set(rb.pos.x || 0, rb.pos.y || 0, rb.pos.z || 0);
      s.bomb.pos = this._bombPos;
      if (s.bomb.planted && !this._bombInScene) this._placeBombMesh();
    } else {
      s.bomb.pos = null;
      if (!s.bomb.planted) this._removeBombMesh();
    }

    s.phase = remote.phase || s.phase;
    if (s.phase === 'live') {
      this._liveElapsed = Math.max(0, this.game.config.MATCH.ROUND_TIME - s.timer);
    }
    this._lastRoundResult = remote.roundResult || this._lastRoundResult;
    this._matchWinner = remote.matchWinner || null;
    if (s.phase !== previousPhase) {
      if (s.phase === 'roundEnd') {
        const result = remote.roundResult || {};
        if (result.winner) this._applyRoundEconomy(result.winner, result.reason, result.defuserId || null);
        this.game.events.emit('round:end', result);
      } else if (s.phase === 'gameEnd') {
        this.game.events.emit('game:end', {
          winner: remote.matchWinner || (s.scores.ct >= s.scores.t ? 'ct' : 't'),
          scores: { ct: s.scores.ct, t: s.scores.t },
        });
      } else {
        this.game.events.emit('round:phase', { phase: s.phase, site: s.bomb.site });
      }
    }
  }

  // ==========================================================================
  // Per-frame update (first in the main update order — owns the timers)
  // ==========================================================================

  update(dt) {
    const s = this.game.state;
    this._time += dt;

    const mp = this.game.multiplayer;
    if (mp && mp.active && !mp.isAuthority()) {
      // Render the shared clock continuously between authoritative snapshots.
      // This is prediction only: every accepted ordered snapshot corrects it,
      // and a promoted authority receives a wall-clock-adjusted handoff state.
      if (NETWORK_TIMED_PHASES.has(s.phase) && Number.isFinite(s.timer)) {
        s.timer = Math.max(0, s.timer - dt);
      }
      this._updateBombVisual(dt);
      this._updateCanBuy();
      return;
    }

    switch (s.phase) {
      case 'menu':     this._updateMenu(dt);     break;
      case 'freeze':   this._updateFreeze(dt);   break;
      case 'live':     this._updateLive(dt);     break;
      case 'planted':  this._updatePlanted(dt);  break;
      case 'roundEnd': this._updateRoundEnd(dt); break;
      case 'gameEnd':  /* waits for ui:restart */ break;
      default: break;
    }

    this._updateBombVisual(dt);
    this._updateCanBuy();
  }

  // --------------------------------------------------------------------------
  // menu
  // --------------------------------------------------------------------------

  _updateMenu(dt) {
    if (this.game.debug && !this._matchStarted) {
      this._menuT += dt;
      // Emit the same flow as clicking START so input (debug pointer-lock
      // simulation) and audio (context unlock) observe the real signal.
      if (this._menuT >= MENU_AUTOSTART_DELAY) this.game.events.emit('ui:start');
    }
  }

  _onUiStart() {
    if (this.game.state.phase !== 'menu' || this._matchStarted) return;
    this._startMatch();
  }

  _onUiRestart() {
    // Full match reset from anywhere (primarily the gameEnd screen).
    this._removeBombMesh();
    this._cosmeticArmed = false;
    this._matchStarted = false;
    this._startMatch();
  }

  // --------------------------------------------------------------------------
  // freeze
  // --------------------------------------------------------------------------

  _updateFreeze(dt) {
    const s = this.game.state;
    s.timer -= dt;
    if (s.timer <= 0) this._goLive();
  }

  _goLive() {
    const s = this.game.state;
    s.phase = 'live';
    s.timer = this.game.config.MATCH.ROUND_TIME;
    this._liveElapsed = 0;
    this.game.events.emit('round:phase', { phase: 'live' });
  }

  // --------------------------------------------------------------------------
  // live
  // --------------------------------------------------------------------------

  _updateLive(dt) {
    const s = this.game.state;
    s.timer -= dt;
    this._liveElapsed += dt;

    if (this._checkEliminations()) return;
    this._updateHumanPlant(dt);
    if (s.phase !== 'live') return;

    // Time expiry with no plant → CTs held the map.
    if (s.timer <= 0) {
      s.timer = 0;
      this._endRound('ct', 'time');
    }
  }

  _updateHumanPlant(dt) {
    const mp = this.game.multiplayer;
    const bots = this.game.bots;
    if (!mp || !mp.active || (bots && bots.aliveOf('t') > 0)) return;
    const s = this.game.state;
    const bomb = s.bomb;
    let carrier = mp.humans('t').find((p) => p.networkId === bomb.carrierId && p.alive);
    if (!carrier) {
      carrier = mp.humans('t').find((p) => p.alive) || null;
      bomb.carrierId = carrier ? carrier.networkId : null;
      this._plantProgress = 0;
    }
    if (!carrier || !carrier.position) return;

    let site = null;
    const sites = this.game.world && this.game.world.bombSites;
    if (Array.isArray(sites)) {
      for (const candidate of sites) {
        _scratchB.set(carrier.position.x, candidate.center.y, carrier.position.z);
        if (candidate.box && candidate.box.containsPoint(_scratchB)) { site = candidate; break; }
      }
    }
    const isLocal = carrier === this.game.player;
    const input = this.game.input;
    const holding = isLocal
      ? !!(input && typeof input.isDown === 'function' && input.isDown('e'))
      : !!carrier.useDown;
    const speed = typeof carrier.moveSpeed2D === 'number'
      ? carrier.moveSpeed2D
      : (carrier.velocity ? Math.hypot(carrier.velocity.x, carrier.velocity.z) : 0);
    if (!site || !holding || speed > PLANT_MOVE_EPS) {
      this._plantProgress = 0;
      bomb.plantProgress = 0;
      return;
    }

    this._plantProgress += dt;
    bomb.plantProgress = this._plantProgress;
    bomb.plantTime = this.game.config.MATCH.PLANT_TIME;
    if (this._plantProgress >= this.game.config.MATCH.PLANT_TIME) {
      this._plantProgress = 0;
      bomb.plantProgress = 0;
      this.game.events.emit('bomb:planted', {
        site: site.name,
        pos: carrier.position.clone(),
        by: carrier,
      });
    }
  }

  // --------------------------------------------------------------------------
  // planted
  // --------------------------------------------------------------------------

  _updatePlanted(dt) {
    const s = this.game.state;
    s.timer -= dt;

    // T elimination win is immediate even with the bomb down; CT "all Ts
    // dead" does NOT end the round while planted (handled inside the check).
    if (this._checkEliminations()) return;

    // Stale-out a bot's defusingBy tag (bots emit start but never cancel).
    if (this._botDefuseTimer > 0) {
      this._botDefuseTimer -= dt;
      if (this._botDefuseTimer <= 0 && s.bomb.defusingBy !== 'player') {
        s.bomb.defusingBy = null;
      }
    }

    // Any living CT human may hold E to defuse.
    this._updateHumanDefuse(dt);
    if (s.phase !== 'planted') return;

    // Fuse expiry → detonation.
    if (s.timer <= 0) {
      s.timer = 0;
      this._detonate();
    }
  }

  _updateHumanDefuse(dt) {
    const s = this.game.state;
    const bomb = s.bomb;
    const local = this.game.player;
    const mp = this.game.multiplayer;
    const humans = mp && mp.active ? mp.humans('ct') : [local];
    let defusing = false;

    for (const player of humans) {
      if (!player || !player.alive || player.onGround === false || !player.position) continue;
      const isLocal = player === local;
      const input = this.game.input;
      const holding = isLocal
        ? !!(input && typeof input.isDown === 'function' && input.isDown('e'))
        : !!player.useDown;
      if (!holding) continue;
      const p = player.position;
      const dx = p.x - this._bombPos.x;
      const dy = p.y - this._bombPos.y;
      const dz = p.z - this._bombPos.z;
      if (dx * dx + dy * dy + dz * dz <= DEFUSE_RANGE * DEFUSE_RANGE) {
        const speed = typeof player.moveSpeed2D === 'number'
          ? player.moveSpeed2D
          : (player.velocity ? Math.hypot(player.velocity.x, player.velocity.z) : 0);
        if (speed > DEFUSE_MOVE_EPS) {
          bomb.defuseProgress = 0;
        } else {
          defusing = true;
          const needed = player.hasKit
            ? this.game.config.MATCH.DEFUSE_TIME_KIT
            : this.game.config.MATCH.DEFUSE_TIME;
          bomb.defuseTime = needed; // additive helper for the HUD fill bar
          bomb.defusingBy = isLocal ? 'player' : player.name;
          bomb.defuseProgress += dt;

          if (bomb.defuseProgress >= needed && !this._defuseEmitted) {
            this._defuseEmitted = true;
            bomb.defuseProgress = needed;
            this._setBombDefusedVisual();
            this.game.events.emit('bomb:defused', { by: isLocal ? 'player' : player });
            return;
          }
        }
        break;
      }
    }

    if (!defusing) {
      // Released E / walked away / died mid-defuse → progress resets.
      bomb.defuseProgress = 0;
      const humanTag = bomb.defusingBy === 'player' || (mp && mp.remotePlayers.some(
        (remote) => remote.name === bomb.defusingBy
      ));
      if (humanTag) bomb.defusingBy = null;
    }
  }

  _detonate() {
    const s = this.game.state;
    const pos = this._bombPos;

    // Combat listens to bomb:detonated, applies the radial damage, and emits
    // the single fx:explosion for effects/audio.
    this.game.events.emit('bomb:detonated', { pos: pos.clone() });

    this._removeBombMesh();
    this._endRound('t', 'bomb');
  }

  // --------------------------------------------------------------------------
  // roundEnd → next round / gameEnd
  // --------------------------------------------------------------------------

  _updateRoundEnd(dt) {
    const s = this.game.state;
    s.timer -= dt;
    if (s.timer > 0) return;
    s.timer = 0;

    if (this._matchWinner) {
      s.phase = 'gameEnd';
      this.game.events.emit('game:end', {
        winner: this._matchWinner,
        scores: { ct: s.scores.ct, t: s.scores.t },
      });
    } else {
      this._startRound();
    }
  }

  // ==========================================================================
  // Match / round transitions
  // ==========================================================================

  _startMatch() {
    const s = this.game.state;
    this._matchStarted = true;
    this._matchWinner = null;
    this._lastRoundResult = null;
    this._lossStreak = 0;
    this._economyRound = 0;
    this._playerDiedThisRound = false;
    this._menuT = 0;
    s.scores.ct = 0;
    s.scores.t = 0;
    s.round = 0;
    s.money = this.game.config.ECON.START_MONEY;

    // Fresh match: bought gear from a previous match must not carry over.
    // (player.resetForRound deliberately keeps armor between rounds, so a
    // full restart is the one place armor/kit get zeroed.)
    const player = this.game.player;
    if (player) {
      if (typeof player.armor === 'number') player.armor = 0;
      player.hasKit = false;
    }

    this._startRound();
  }

  _startRound() {
    const s = this.game.state;
    const cfg = this.game.config;
    const died = this._playerDiedThisRound; // outcome of the round just ended

    s.round += 1;
    s.phase = 'freeze';
    s.timer = cfg.MATCH.FREEZE_TIME;
    this._liveElapsed = 0;

    // Reset bomb + defuse bookkeeping.
    this._resetBombState();

    // Bots first — resetForRound respawns everyone and picks the carrier
    // (reads s.round for its weapon-economy tiers, so round is already set).
    const bots = this.game.bots;
    const mp = this.game.multiplayer;
    if (mp && mp.active && typeof mp.prepareRoundRoster === 'function') {
      // Late human joiners observe the current round. Swap their team's bot
      // slot only at this boundary, immediately before the new roster resets.
      mp.prepareRoundRoster(s.round);
    }
    if (bots && typeof bots.resetForRound === 'function') bots.resetForRound();

    // With no T bots, a living T human carries the C4 for this round.
    if (mp && mp.active && (!bots || bots.aliveOf('t') === 0)) {
      const carrier = mp.humans('t').find((p) => p.alive);
      s.bomb.carrierId = carrier ? carrier.networkId : null;
    }

    // Player to a CT spawn. Bots typically consume spawns from the front of
    // the list, so the player takes the last one to avoid stacking.
    const team = (this.game.player && this.game.player.team) || 'ct';
    const playerIndex = mp && mp.active ? mp.localTeamIndex() : 0;
    const spawn = this._pickPlayerSpawn(team, playerIndex);
    const player = this.game.player;
    if (player && typeof player.resetForRound === 'function') {
      player.resetForRound(spawn);
    }
    // Dying loses the defuse kit (CS rule); armor persistence is player's.
    if (player && died) player.hasKit = false;

    // Weapons: keep guns if survived; back to pistol if died last round.
    const weapons = this.game.weapons;
    if (weapons && typeof weapons.resetForRound === 'function') {
      weapons.resetForRound({ died });
    }
    this._playerDiedThisRound = false;

    // Effects/HUD/audio clear + react off these.
    this.game.events.emit('round:start', { round: s.round });
    this.game.events.emit('round:phase', { phase: 'freeze' });
  }

  _resetBombState() {
    const s = this.game.state;
    this._removeBombMesh();
    this._cosmeticArmed = false;
    this._defuseEmitted = false;
    this._lastDefuser = null;
    this._lastDefuserId = null;
    this._botDefuseTimer = 0;
    this._plantProgress = 0;
    s.bomb.planted = false;
    s.bomb.site = null;
    s.bomb.pos = null;
    s.bomb.defusingBy = null;
    s.bomb.defuseProgress = 0;
    s.bomb.defuseTime = this.game.config.MATCH.DEFUSE_TIME;
    s.bomb.plantProgress = 0;
    s.bomb.plantTime = this.game.config.MATCH.PLANT_TIME;
    s.bomb.carrierId = null;
  }

  _pickPlayerSpawn(team = 'ct', index = 0) {
    const world = this.game.world;
    const list = world && world.spawns && Array.isArray(world.spawns[team])
      ? world.spawns[team]
      : null;

    if (list && list.length > 0) {
      const src = list[Math.max(0, index) % list.length];
      if (src && src.pos) {
        this._playerSpawnPos.set(src.pos.x || 0, src.pos.y || 0, src.pos.z || 0);
        this._hasPlayerSpawn = true;
        // Defensive copy — never hand modules a vector another module owns.
        return { pos: this._playerSpawnPos.clone(), yaw: src.yaw || 0 };
      }
    }
    if (!this._warnedNoSpawn) {
      this._warnedNoSpawn = true;
      console.warn(`[rounds] world.spawns.${team} missing — using origin spawn`);
    }
    this._playerSpawnPos.set(0, 0, 0);
    this._hasPlayerSpawn = true;
    return { pos: new THREE.Vector3(0, 0, 0), yaw: 0 };
  }

  /**
   * Ends the current round. Guarded so simultaneous triggers (e.g. a defuse
   * completing the same frame eliminations are checked) resolve exactly once.
   */
  _endRound(winner, reason) {
    const s = this.game.state;
    if (s.phase !== 'live' && s.phase !== 'planted') return;

    // T elimination win with the bomb still armed: keep the fuse ticking
    // cosmetically so the C4 still goes off during the round-end slack.
    if (s.phase === 'planted' && reason === 'elimination' && !this._defuseEmitted) {
      this._cosmeticArmed = true;
      this._cosmeticFuse = Math.max(0.4, s.timer);
    }

    s.phase = 'roundEnd';
    s.timer = this.game.config.MATCH.ROUND_END_TIME;
    s.canBuy = false;
    s.bomb.defusingBy = null;

    s.scores[winner] = (s.scores[winner] || 0) + 1;

    this._lastRoundResult = {
      winner,
      reason,
      defuserId: this._lastDefuserId,
    };
    this._applyRoundEconomy(winner, reason, this._lastDefuserId);

    this.game.events.emit('round:end', { winner, reason });

    // Match over?
    const cfg = this.game.config.MATCH;
    if (s.scores[winner] >= cfg.WIN_ROUNDS) {
      this._matchWinner = winner;
    } else if (s.round >= cfg.MAX_ROUNDS) {
      // Safety net (unreachable with first-to-8-of-15, but bulletproof):
      this._matchWinner =
        s.scores.ct > s.scores.t ? 'ct' :
        s.scores.t > s.scores.ct ? 't' : winner;
    }
  }

  _applyRoundEconomy(winner, reason, defuserId = null) {
    const econ = this.game.config.ECON;
    const player = this.game.player;
    const playerTeam = (player && player.team) || 'ct';
    if (winner === playerTeam) {
      // Player team won.
      this._lossStreak = 0;
      this._addMoney(econ.WIN_REWARD);
      const localId = player && player.networkId;
      if (reason === 'defuse' && (this._lastDefuser === 'player' || (localId && defuserId === localId))) {
        this._addMoney(econ.DEFUSE_REWARD);
      }
    } else {
      this._lossStreak += 1;
      const bonus = Math.min(
        econ.LOSS_BASE + econ.LOSS_STEP * (this._lossStreak - 1),
        econ.LOSS_MAX
      );
      this._addMoney(bonus);
    }
    this._economyRound = Math.max(this._economyRound, Math.floor(Number(this.game.state.round) || 0));
  }

  _addMoney(amount) {
    const s = this.game.state;
    const max = this.game.config.ECON.MAX_MONEY;
    s.money = Math.max(0, Math.min(max, s.money + amount));
  }

  // ==========================================================================
  // Win-condition helpers
  // ==========================================================================

  /**
   * Elimination checks. Returns true if the round ended.
   * Order matters: "all CTs dead" first, so a simultaneous wipe (e.g. one HE
   * killing the last player on each side) resolves deterministically as a
   * T win — matching the spec's "T elimination win is immediate".
   */
  _checkEliminations() {
    const s = this.game.state;
    const bots = this.game.bots;
    if (!bots || typeof bots.aliveOf !== 'function') return false; // stub-safe
    if (!Array.isArray(bots.all)) return false;
    const mp = this.game.multiplayer;
    const player = this.game.player;
    let ctAlive = bots.aliveOf('ct');
    let tAlive = bots.aliveOf('t');
    if (mp && mp.active) {
      ctAlive += mp.aliveOf('ct');
      tAlive += mp.aliveOf('t');
    } else {
      if (!bots.all.length) return false;
      if (player && player.alive) player.team === 't' ? tAlive++ : ctAlive++;
    }

    if (ctAlive <= 0) {
      this._endRound('t', 'elimination');
      return true;
    }
    if (tAlive <= 0 && !s.bomb.planted) {
      // With the bomb planted, killing every T does NOT end the round —
      // the bomb must still be defused (CS rule).
      this._endRound('ct', 'elimination');
      return true;
    }
    return false;
  }

  // ==========================================================================
  // Bomb event handlers
  // ==========================================================================

  _onBombPlanted(p) {
    const s = this.game.state;
    if (s.phase !== 'live') {
      if (!this._warnedPlantPhase) {
        this._warnedPlantPhase = true;
        console.warn('[rounds] bomb:planted ignored outside live phase');
      }
      return;
    }

    const pos = p && p.pos ? p.pos : null;
    if (pos) this._bombPos.set(pos.x || 0, pos.y || 0, pos.z || 0);
    else this._bombPos.set(0, 0, 0);

    s.phase = 'planted';
    s.timer = this.game.config.MATCH.BOMB_TIME;
    s.bomb.planted = true;
    s.bomb.site = (p && p.site) || null;
    s.bomb.pos = this._bombPos; // stable Vector3 owned by this module
    s.bomb.defusingBy = null;
    s.bomb.defuseProgress = 0;
    this._defuseEmitted = false;
    this._botDefuseTimer = 0;

    this._placeBombMesh();

    this.game.events.emit('round:phase', { phase: 'planted', site: s.bomb.site });
  }

  _onBombDefused(p) {
    const s = this.game.state;
    if (s.phase !== 'planted') return; // late/duplicate → ignore

    const by = p && p.by !== undefined ? p.by : null;
    this._lastDefuser =
      by === 'player' ? 'player' :
      by && by.name ? by.name :
      by || null;
    this._lastDefuserId = by && by.networkId ? by.networkId
      : (by === 'player' && this.game.player ? this.game.player.networkId : null);

    this._defuseEmitted = true;
    this._setBombDefusedVisual();
    this._endRound('ct', 'defuse');
  }

  _onBotDefusing(p) {
    const s = this.game.state;
    if (s.phase !== 'planted') return;
    if (s.bomb.defusingBy) return; // human defuser display wins
    const bot = p && p.bot;
    s.bomb.defusingBy = (bot && bot.name) || 'bot';
    this._botDefuseTimer = BOT_DEFUSE_STALE;
  }

  // ==========================================================================
  // Buy-window flag (recomputed every frame; HUD & weapons read state.canBuy)
  // ==========================================================================

  _updateCanBuy() {
    const s = this.game.state;
    let can = false;

    if (s.phase === 'freeze') {
      can = true;
    } else if (s.phase === 'live' && this._liveElapsed <= BUY_WINDOW_LIVE) {
      const player = this.game.player;
      if (player && player.alive && player.position && this._hasPlayerSpawn) {
        const dx = player.position.x - this._playerSpawnPos.x;
        const dz = player.position.z - this._playerSpawnPos.z;
        can = dx * dx + dz * dz <= BUY_ZONE_RADIUS * BUY_ZONE_RADIUS;
      }
    }

    s.canBuy = can;
  }

  // ==========================================================================
  // C4 prop — built once (lazily), reused every plant.
  // ==========================================================================

  _buildBombMesh() {
    const group = new THREE.Group();
    group.name = 'c4';

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);

    const oliveMat = new THREE.MeshStandardMaterial({
      color: 0x3a4030, roughness: 0.72, metalness: 0.18,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x16181c, roughness: 0.5, metalness: 0.4,
    });
    const keyMat = new THREE.MeshStandardMaterial({
      color: 0x8d9287, roughness: 0.6, metalness: 0.1,
    });
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x0a120a, roughness: 0.35, metalness: 0.1,
      emissive: 0x39ff5e, emissiveIntensity: 0.85,
    });
    const ledMat = new THREE.MeshStandardMaterial({
      color: 0x1a0503, roughness: 0.3, metalness: 0.1,
      emissive: 0xff2418, emissiveIntensity: 0,
    });
    const wireMats = [
      new THREE.MeshStandardMaterial({ color: 0xb42222, roughness: 0.8 }),
      new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.8 }),
      new THREE.MeshStandardMaterial({ color: 0x2a4fae, roughness: 0.8 }),
    ];

    const addBox = (mat, x, y, z, sx, sy, sz, ry, shadows) => {
      const m = new THREE.Mesh(boxGeo, mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      if (ry) m.rotation.y = ry;
      m.castShadow = !!shadows;
      m.receiveShadow = true;
      group.add(m);
      return m;
    };

    // Main charge body + strapped side blocks (classic C4 silhouette).
    addBox(oliveMat, 0, 0.065, 0, 0.38, 0.13, 0.26, 0, true);
    addBox(oliveMat, -0.145, 0.075, 0, 0.1, 0.15, 0.22, 0, true);
    addBox(oliveMat, 0.145, 0.075, 0, 0.1, 0.15, 0.22, 0, true);
    // Straps.
    addBox(darkMat, -0.07, 0.066, 0, 0.03, 0.135, 0.265, 0, false);
    addBox(darkMat, 0.07, 0.066, 0, 0.03, 0.135, 0.265, 0, false);

    // Top faceplate.
    addBox(darkMat, 0.01, 0.138, 0, 0.27, 0.02, 0.2, 0, false);

    // LCD timer screen (upper-left of plate).
    const screen = addBox(screenMat, -0.05, 0.152, -0.05, 0.13, 0.012, 0.06, 0, false);
    screen.castShadow = false;

    // 3x3 keypad (lower-right of plate).
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        addBox(
          keyMat,
          0.035 + c * 0.036, 0.15, -0.005 + r * 0.038,
          0.026, 0.012, 0.026, 0, false
        );
      }
    }

    // Wires draped over the front edge.
    for (let i = 0; i < 3; i++) {
      addBox(
        wireMats[i],
        -0.06 + i * 0.05, 0.1, 0.132,
        0.012, 0.1, 0.012, 0.12 * (i - 1), false
      );
    }

    // Blinking arm LED (front-right corner of the plate).
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), ledMat);
    led.position.set(0.115, 0.152, -0.07);
    led.castShadow = false;
    group.add(led);

    // Small antenna.
    addBox(darkMat, 0.115, 0.2, 0.09, 0.008, 0.11, 0.008, 0, false);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.01, 8, 6), darkMat);
    tip.position.set(0.115, 0.256, 0.09);
    group.add(tip);

    // Faint red glow synced to the LED (kept subtle — effects owns the big
    // pulsing site light).
    const light = new THREE.PointLight(0xff3a22, 0, 6, 2);
    light.position.set(0.1, 0.28, -0.05);
    light.castShadow = false;
    group.add(light);

    this._bombGroup = group;
    this._bombLedMat = ledMat;
    this._bombScreenMat = screenMat;
    this._bombLight = light;
  }

  _placeBombMesh() {
    if (!this._bombGroup) this._buildBombMesh();
    const group = this._bombGroup;

    // Snap to the floor under the plant point when the world can tell us.
    let y = this._bombPos.y;
    const world = this.game.world;
    if (world && typeof world.raycast === 'function') {
      _scratchA.set(this._bombPos.x, this._bombPos.y + 0.6, this._bombPos.z);
      _scratchB.set(0, -1, 0);
      const hit = world.raycast(_scratchA, _scratchB, 3);
      if (hit && hit.point) y = hit.point.y;
    }

    group.position.set(this._bombPos.x, y + 0.004, this._bombPos.z);
    group.rotation.set(0, Math.random() * Math.PI * 2, 0);

    // Re-arm visuals (materials persist across rounds).
    this._bombDefusedVisual = false;
    this._bombLedMat.color.setHex(0x1a0503);
    this._bombLedMat.emissive.setHex(0xff2418);
    this._bombLedMat.emissiveIntensity = 0;
    this._bombLight.color.setHex(0xff3a22);
    this._bombLight.intensity = 0;
    this._bombScreenMat.emissive.setHex(0x39ff5e);
    this._blinkT = 0;
    this._ledOnT = 0;
    this._ledOn = false;

    const scene = this.game.scene;
    if (scene && !this._bombInScene) {
      scene.add(group);
      this._bombInScene = true;
    }
  }

  _removeBombMesh() {
    if (this._bombInScene && this._bombGroup) {
      const scene = this.game.scene;
      if (scene) scene.remove(this._bombGroup);
    }
    this._bombInScene = false;
    this._cosmeticArmed = false;
  }

  _setBombDefusedVisual() {
    if (!this._bombGroup) return;
    this._bombDefusedVisual = true;
    // Steady green: threat neutralized.
    this._bombLedMat.emissive.setHex(0x2bff66);
    this._bombLedMat.emissiveIntensity = 2.2;
    this._bombLight.color.setHex(0x2bff66);
    this._bombLight.intensity = 0.5;
    this._bombScreenMat.emissive.setHex(0x9fffb4);
    this._bombScreenMat.emissiveIntensity = 1.1;
    this._ledOn = false;
  }

  _setLED(on) {
    this._ledOn = on;
    this._ledOnT = 0;
    if (this._bombLedMat) this._bombLedMat.emissiveIntensity = on ? 3.4 : 0;
    if (this._bombLight) this._bombLight.intensity = on ? 1.4 : 0;
  }

  _updateBombVisual(dt) {
    if (!this._bombInScene) return;
    const s = this.game.state;

    // Cosmetic fuse: T won by elimination while the bomb was armed — the C4
    // still goes off during round-end slack (visual/audio only, no damage).
    if (this._cosmeticArmed && s.phase !== 'planted') {
      this._cosmeticFuse -= dt;
      if (this._cosmeticFuse <= 0) {
        this.game.events.emit('fx:explosion', {
          pos: this._bombPos.clone(),
          radius: DETONATION_RADIUS,
        });
        this._removeBombMesh();
        return;
      }
    }

    if (this._bombDefusedVisual) {
      // Gentle steady-green pulse on the screen; no blinking.
      if (this._bombScreenMat) {
        this._bombScreenMat.emissiveIntensity = 1.0 + Math.sin(this._time * 2.4) * 0.12;
      }
      return;
    }

    // Blink cadence mirrors the audio beep formula: clamp(timer/40, 0.12, 1) s.
    const remain = s.phase === 'planted'
      ? Math.max(0, s.timer)
      : (this._cosmeticArmed ? Math.max(0, this._cosmeticFuse) : 0);
    if (remain <= 0 && s.phase !== 'planted' && !this._cosmeticArmed) return;

    const interval = Math.min(1, Math.max(0.12, remain / 40));

    if (this._ledOn) {
      this._ledOnT += dt;
      if (this._ledOnT >= LED_ON_TIME) this._setLED(false);
    }
    this._blinkT += dt;
    if (this._blinkT >= interval) {
      this._blinkT = 0;
      this._setLED(true);
    }

    // Nervous little LCD flicker that tightens as the fuse runs down.
    if (this._bombScreenMat) {
      const urgency = 1 - Math.min(1, remain / this.game.config.MATCH.BOMB_TIME);
      this._bombScreenMat.emissiveIntensity =
        0.8 + urgency * 0.35 + Math.sin(this._time * (3 + urgency * 9)) * 0.12;
    }
  }
}
