import test from 'node:test';
import assert from 'node:assert/strict';

import AudioSys, { rewardHapticPattern } from '../src/audio/audio.js';

function cueHarness() {
  const calls = {
    direct: [],
    critical: [],
    noise: [],
    tone: [],
    mech: [],
    blip: [],
    duck: [],
    muffle: [],
    haptic: [],
  };
  const audio = Object.create(AudioSys.prototype);
  audio.ctx = { currentTime: 10, state: 'running' };
  audio.music = { id: 'music' };
  audio._lastDeployCue = -100;
  audio._lastHitmarkerAt = -100;
  audio._lastHitmarkerKill = false;
  audio._lastEliminationCueAt = -100;
  audio._pendingEliminationAt = -1;
  audio._nextRewardCueAt = -1;
  audio._ready = () => true;
  audio._t = () => audio.ctx.currentTime + 0.003;
  audio._direct = (vol, bus) => {
    const grp = { id: calls.direct.length };
    calls.direct.push({ vol, bus, grp });
    return grp;
  };
  audio._critical = (vol) => {
    const grp = { id: 'critical-' + calls.critical.length };
    calls.critical.push({ vol, grp });
    return grp;
  };
  audio._noiseHit = (grp, at, opts) => calls.noise.push({ grp, at, opts });
  audio._tone = (grp, at, opts) => calls.tone.push({ grp, at, opts });
  audio._mech = (grp, at, frequency, volume) => calls.mech.push({ grp, at, frequency, volume });
  audio._blip = (...args) => calls.blip.push(args);
  audio._duckMaster = (...args) => calls.duck.push(args);
  audio._muffle = (...args) => calls.muffle.push(args);
  audio._rewardHaptic = (kind) => { calls.haptic.push(kind); return true; };
  return { audio, calls };
}

function clearLayers(calls) {
  calls.direct.length = 0;
  calls.critical.length = 0;
  calls.noise.length = 0;
  calls.tone.length = 0;
  calls.mech.length = 0;
  calls.blip.length = 0;
  calls.duck.length = 0;
  calls.muffle.length = 0;
  calls.haptic.length = 0;
}

test('audio subscribes to all three progression reward events', (t) => {
  const previousWindow = globalThis.window;
  const names = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener() {} },
  });
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  });
  const audio = Object.create(AudioSys.prototype);
  audio.game = { events: { on(name) { names.push(name); } } };

  audio._bind();

  assert.ok(names.includes('progress:achievement'));
  assert.ok(names.includes('progress:record'));
  assert.ok(names.includes('progress:level-up'));
});

test('hit and elimination confirmations are percussive instead of melodic beeps', () => {
  const { audio, calls } = cueHarness();

  audio._onHitmarker({ headshot: false, kill: false });
  assert.equal(calls.blip.length, 0);
  assert.ok(calls.noise.length >= 2, 'body hit should be led by filtered impact noise');
  assert.ok(calls.tone.every(({ opts }) => opts.f < 150), 'any tonal weight stays in the bass range');
  const bodyLayers = calls.noise.length + calls.tone.length;

  clearLayers(calls);
  audio._onHitmarker({ headshot: true, kill: true });
  assert.equal(calls.critical.length, 1, 'kill feedback bypasses gunfire masking');
  assert.equal(calls.blip.length, 0, 'kill no longer plays an ascending reward melody');
  assert.ok(calls.noise.length >= 7, 'headshot kill has distinct impact and elimination layers');
  assert.ok(calls.noise.length + calls.tone.length > bodyLayers);
  assert.ok(calls.tone.every(({ opts }) => opts.f < 150), 'headshot resonance is noise, not a pitched chime');
});

test('player death uses shock, fall, breath, and gear layers with pressure ducking', () => {
  const { audio, calls } = cueHarness();

  audio._onPlayerDeath();
  assert.equal(calls.critical.length, 1, 'death remains audible while world audio is ducked');
  assert.ok(calls.noise.length >= 4);
  assert.equal(calls.mech.length, 2);
  assert.equal(calls.blip.length, 0);
  assert.ok(calls.tone.every(({ opts }) => opts.f < 100));
  assert.ok(calls.noise.some(({ opts }) =>
    opts.type === 'bandpass' && opts.f >= 250 && opts.f <= 900 && opts.vol >= 0.4
  ), 'death includes a laptop-audible midrange body/cloth landing');
  assert.deepEqual(calls.duck, [[0.44, 3.0]]);
  assert.deepEqual(calls.muffle, [[760, 3.2]]);
});

test('match start and freeze/live transitions use tactical non-melodic cues', () => {
  const { audio, calls } = cueHarness();

  audio._onGameStart();
  assert.equal(calls.direct.length, 1);
  assert.equal(calls.direct[0].bus, audio.music);
  assert.ok(calls.noise.length >= 3);
  assert.equal(calls.mech.length, 2);
  assert.equal(calls.blip.length, 0);

  clearLayers(calls);
  audio._onPhase({ phase: 'freeze' });
  assert.equal(calls.direct.length, 0, 'first freeze cue is covered by match deployment');

  audio.ctx.currentTime += 2;
  clearLayers(calls);
  audio._onPhase({ phase: 'freeze' });
  assert.ok(calls.noise.length >= 1);
  assert.equal(calls.mech.length, 2);
  assert.equal(calls.blip.length, 0);

  clearLayers(calls);
  audio._onPhase({ phase: 'live' });
  assert.ok(calls.noise.length >= 3);
  assert.equal(calls.mech.length, 1);
  assert.equal(calls.blip.length, 0, 'round-live no longer plays a rising two-note beep');
  assert.ok(calls.tone.every(({ opts }) => opts.f < 100));
});

test('local kill event guarantees one foreground elimination cue and dedupes hitmarker fallback', () => {
  const { audio, calls } = cueHarness();

  audio._onLocalKill({ weaponId: 'ak47', reward: 300 });
  assert.equal(calls.critical.length, 0, 'cue briefly waits for detailed kill metadata');
  audio._onKillEvent({ headshot: true, victimId: 'bot-1' });
  assert.equal(calls.critical.length, 1);
  assert.ok(calls.noise.length >= 5, 'elimination has a clear multi-layer material stamp');
  assert.equal(calls.blip.length, 0);
  const eliminationNoise = calls.noise.length;

  audio._onHitmarker({ headshot: true, kill: true });
  assert.equal(calls.critical.length, 2, 'the impact snap is still heard');
  assert.ok(calls.noise.length > eliminationNoise, 'hit impact layers are retained');
  assert.ok(calls.noise.length < eliminationNoise * 2,
    'recent econ kill prevents a duplicate elimination tail');

  const groups = calls.critical.length;
  audio._onLocalKill({ weaponId: 'ak47', reward: 300 });
  assert.equal(calls.critical.length, groups, 'echoed local kill is debounced');
});

test('local kill retains a timed generic fallback when detailed metadata is absent', () => {
  const { audio, calls } = cueHarness();

  audio._onLocalKill({ weaponId: 'hegrenade', reward: 300 });
  assert.ok(audio._pendingEliminationAt > audio.ctx.currentTime);
  audio.ctx.currentTime = audio._pendingEliminationAt;
  audio.game = { state: {} };
  audio.update(0.016);
  assert.equal(calls.critical.length, 1);
  assert.equal(audio._pendingEliminationAt, -1);
});

test('purchase cue sounds like handled equipment rather than a register beep', () => {
  const { audio, calls } = cueHarness();

  audio._onBuy({ id: 'ak47', price: 2700 });
  assert.equal(calls.critical.length, 1);
  assert.ok(calls.noise.length >= 4);
  assert.equal(calls.blip.length, 0);
  assert.ok(calls.tone.every(({ opts }) => opts.f < 100),
    'purchase tonal weight is sub-bass, not a high coin chime');

  clearLayers(calls);
  audio._onBuy({ id: 'armor', price: 650 });
  assert.ok(calls.noise.length >= 4, 'soft gear has its own pouch/buckle variation');
  assert.equal(calls.blip.length, 0);
});

test('round and match outcomes use distinct physical stingers with no note sequences', () => {
  const { audio, calls } = cueHarness();
  const cases = [
    ['round win', () => audio._onRoundEnd({ winner: 'ct' })],
    ['round loss', () => audio._onRoundEnd({ winner: 't' })],
    ['match win', () => audio._onGameEnd({ winner: 'ct' })],
    ['match loss', () => audio._onGameEnd({ winner: 't' })],
  ];

  for (const [label, play] of cases) {
    clearLayers(calls);
    play();
    assert.equal(calls.critical.length, 1, `${label} remains clear of compressor masking`);
    assert.ok(calls.noise.length >= 4, `${label} has layered physical texture`);
    assert.equal(calls.blip.length, 0, `${label} has no melodic UI blips`);
    assert.ok(calls.tone.every(({ opts }) => opts.f < 100),
      `${label} only uses non-melodic sub-bass weight`);
  }

  clearLayers(calls);
  audio.game = { player: { team: 't' } };
  audio._onGameEnd({ winner: 't' });
  assert.equal(calls.noise.length, 5, 'multiplayer T winner receives the victory design');
});

test('round outcome waits for an active local death collapse to finish', () => {
  const { audio, calls } = cueHarness();
  audio.game = {
    player: { team: 'ct', alive: false, spectatorReady: false },
  };

  audio._onRoundEnd({ winner: 't' });

  assert.equal(calls.critical.length, 1);
  const firstLayerAt = Math.min(...calls.noise.map(({ at }) => at));
  assert.ok(firstLayerAt - audio.ctx.currentTime >= 1.35,
    'outcome sound starts near spectator handoff, after death foley');
});

test('achievement, record, and level-up rewards use physical cues and distinct haptics', () => {
  const { audio, calls } = cueHarness();
  const rewards = [
    ['achievement', () => audio._onAchievement(), 2, 1],
    ['record', () => audio._onPersonalRecord(), 4, 1],
    ['level', () => audio._onLevelUp(), 4, 2],
  ];

  let previousEnd = audio.ctx.currentTime;
  for (const [kind, play, minimumNoise, minimumBass] of rewards) {
    clearLayers(calls);
    assert.equal(play(), true);
    assert.equal(calls.critical.length, 1, `${kind} remains audible over match audio`);
    assert.ok(calls.noise.length >= minimumNoise, `${kind} is led by filtered material texture`);
    assert.ok(calls.tone.length >= minimumBass);
    assert.ok(calls.tone.every(({ opts }) => opts.f < 100), `${kind} has no high notification tones`);
    assert.equal(calls.blip.length, 0, `${kind} never uses the melodic blip helper`);
    assert.deepEqual(calls.haptic, [kind]);
    const firstLayerAt = Math.min(...calls.noise.map(({ at }) => at));
    assert.ok(firstLayerAt >= previousEnd, 'reward bursts queue instead of masking one another');
    previousEnd = firstLayerAt;
  }

  assert.deepEqual(rewardHapticPattern('achievement'), [18]);
  assert.deepEqual(rewardHapticPattern('record'), [22, 34, 46]);
  assert.deepEqual(rewardHapticPattern('level'), [24, 28, 24, 28, 62]);
});

test('reward haptics are suppressed while the page is hidden', (t) => {
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const patterns = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { visibilityState: 'hidden' },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { vibrate(pattern) { patterns.push(pattern); return true; } },
  });
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    if (previousNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
  });

  const audio = Object.create(AudioSys.prototype);
  assert.equal(audio._rewardHaptic('record'), false);
  assert.deepEqual(patterns, []);
  globalThis.document.visibilityState = 'visible';
  assert.equal(audio._rewardHaptic('record'), true);
  assert.deepEqual(patterns, [[22, 34, 46]]);
});
