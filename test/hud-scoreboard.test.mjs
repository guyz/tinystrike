import assert from 'node:assert/strict';
import test from 'node:test';

import HUD, { compareScoreboardRows } from '../src/ui/hud.js';

function scoreboardHud() {
  const hud = Object.create(HUD.prototype);
  hud.game = {
    profile: { name: 'Quartz' },
    player: { name: 'Quartz', team: 'ct', alive: false },
    multiplayer: null,
    bots: {
      all: [
        { id: 'atlas', name: 'Atlas', team: 'ct', alive: true },
        { id: 'blitz', name: 'Blitz', team: 'ct', alive: true },
        { id: 'cipher', name: 'Cipher', team: 'ct', alive: true },
        { id: 'viper', name: 'Viper', team: 't', alive: true },
      ],
    },
  };
  hud._stats = new Map([
    ['You', { k: 5, d: 4 }],
    ['Atlas', { k: 5, d: 1 }],
    ['Blitz', { k: 7, d: 9 }],
    ['Cipher', { k: 4, d: 0 }],
    ['Viper', { k: 2, d: 3 }],
  ]);
  hud._el = { sbBody: { innerHTML: '' } };
  hud._sbDirty = true;
  return hud;
}

test('scoreboard ranks each team by most kills and then least deaths', () => {
  const hud = scoreboardHud();
  hud._rebuildScoreboard();

  const ctBody = hud._el.sbBody.innerHTML
    .split('<div class="sb-team sb-t">')[0]
    .split('<tbody>')[1];
  const positions = ['Blitz', 'Atlas', 'Quartz', 'Cipher'].map((name) => ctBody.indexOf(name));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(ctBody, /Quartz<\/span><span class="sb-self-tag">YOU<\/span>[\s\S]*?<td>5<\/td><td>4<\/td>/);
});

test('scoreboard tie-breaking is stable and independent of roster insertion order', () => {
  const rows = [
    { name: 'Zulu', sortId: '2', order: 0, stats: { k: 3, d: 2 } },
    { name: 'Alpha', sortId: '9', order: 1, stats: { k: 3, d: 2 } },
    { name: 'Alpha', sortId: '1', order: 2, stats: { k: 3, d: 2 } },
  ];
  assert.deepEqual(
    rows.sort(compareScoreboardRows).map((row) => `${row.name}:${row.sortId}`),
    ['Alpha:1', 'Alpha:9', 'Zulu:2']
  );
});

test('local scoreboard row is explicitly identified even after death', () => {
  const hud = scoreboardHud();
  hud._rebuildScoreboard();

  const localRow = hud._el.sbBody.innerHTML.match(/<tr class="[^"]*sb-you[^"]*"[^>]*>[\s\S]*?<\/tr>/)?.[0] || '';
  const remoteRow = hud._el.sbBody.innerHTML.match(/<tr class=""[^>]*>[\s\S]*?Atlas[\s\S]*?<\/tr>/)?.[0] || '';
  assert.match(localRow, /class="sb-dead sb-you"/);
  assert.match(localRow, /aria-current="true"/);
  assert.match(localRow, /class="sb-self-tag">YOU<\/span>/);
  assert.doesNotMatch(remoteRow, /sb-self-tag|aria-current/);
});
