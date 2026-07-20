import test from 'node:test';
import assert from 'node:assert/strict';

import AudioSys from '../src/audio/audio.js';

function cueHarness() {
  const calls = {
    direct: [],
    noise: [],
    tone: [],
    mech: [],
    blip: [],
    duck: [],
    muffle: [],
  };
  const audio = Object.create(AudioSys.prototype);
  audio.ctx = { currentTime: 10, state: 'running' };
  audio.music = { id: 'music' };
  audio._lastDeployCue = -100;
  audio._ready = () => true;
  audio._t = () => audio.ctx.currentTime + 0.003;
  audio._direct = (vol, bus) => {
    const grp = { id: calls.direct.length };
    calls.direct.push({ vol, bus, grp });
    return grp;
  };
  audio._noiseHit = (grp, at, opts) => calls.noise.push({ grp, at, opts });
  audio._tone = (grp, at, opts) => calls.tone.push({ grp, at, opts });
  audio._mech = (grp, at, frequency, volume) => calls.mech.push({ grp, at, frequency, volume });
  audio._blip = (...args) => calls.blip.push(args);
  audio._duckMaster = (...args) => calls.duck.push(args);
  audio._muffle = (...args) => calls.muffle.push(args);
  return { audio, calls };
}

function clearLayers(calls) {
  calls.direct.length = 0;
  calls.noise.length = 0;
  calls.tone.length = 0;
  calls.mech.length = 0;
  calls.blip.length = 0;
  calls.duck.length = 0;
  calls.muffle.length = 0;
}

test('hit and elimination confirmations are percussive instead of melodic beeps', () => {
  const { audio, calls } = cueHarness();

  audio._onHitmarker({ headshot: false, kill: false });
  assert.equal(calls.blip.length, 0);
  assert.ok(calls.noise.length >= 2, 'body hit should be led by filtered impact noise');
  assert.ok(calls.tone.every(({ opts }) => opts.f < 150), 'any tonal weight stays in the bass range');
  const bodyLayers = calls.noise.length + calls.tone.length;

  clearLayers(calls);
  audio._onHitmarker({ headshot: true, kill: true });
  assert.equal(calls.blip.length, 0, 'kill no longer plays an ascending reward melody');
  assert.ok(calls.noise.length >= 7, 'headshot kill has distinct impact and elimination layers');
  assert.ok(calls.noise.length + calls.tone.length > bodyLayers);
  assert.ok(calls.tone.every(({ opts }) => opts.f < 150), 'headshot resonance is noise, not a pitched chime');
});

test('player death uses shock, fall, breath, and gear layers with pressure ducking', () => {
  const { audio, calls } = cueHarness();

  audio._onPlayerDeath();
  assert.ok(calls.noise.length >= 4);
  assert.equal(calls.mech.length, 2);
  assert.equal(calls.blip.length, 0);
  assert.ok(calls.tone.every(({ opts }) => opts.f < 100));
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
