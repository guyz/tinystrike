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

test('online scoreboard and kill feed replace every human placeholder callsign', () => {
  const hud = scoreboardHud();
  hud.game.player = {
    name: 'SilentFalcon-521',
    networkId: 'local-1',
    team: 'ct',
    alive: true,
  };
  hud.game.multiplayer = {
    active: true,
    localId: 'local-1',
    localName: 'SilentFalcon-521',
    remotePlayers: [{
      networkId: 'remote-2',
      name: 'Operative2',
      team: 't',
      alive: true,
    }],
  };
  hud.game.bots = { all: [] };
  hud._networkStatsById = new Map([
    ['local-1', { k: 0, d: 0 }],
    ['remote-2', { k: 0, d: 0 }],
  ]);

  hud._rebuildScoreboard();
  assert.match(hud._el.sbBody.innerHTML, /SilentFalcon-521/);
  assert.doesNotMatch(
    hud._el.sbBody.innerHTML,
    /<span class="sb-callsign">Operative\s*2?<\/span>/i,
  );

  let feedEvent = null;
  hud._addFeed = (event) => { feedEvent = event; };
  hud._showKillCue = () => {};
  hud._onKill({
    killerId: 'remote-2',
    killerName: 'Operative 2',
    victimId: 'local-1',
    victimName: 'Operative',
    weaponId: 'ak47',
  });

  assert.doesNotMatch(feedEvent.killerName, /^operative\s*\d*$/i);
  assert.equal(feedEvent.victimName, 'SilentFalcon-521');
});

test('spectator death HUD repairs a placeholder human target label', () => {
  const hud = Object.create(HUD.prototype);
  hud.game = {
    profile: { name: 'SilentFalcon-521' },
    player: {
      alive: false,
      spectatorReady: true,
      spectatorTarget: {
        id: 'human:remote-2',
        name: 'Operative2',
        team: 'ct',
        kind: 'human',
      },
    },
    multiplayer: {
      active: true,
      localId: 'local-1',
      localName: 'SilentFalcon-521',
      waitingForNextRound: false,
      remotePlayers: [],
    },
    input: { touchMode: false },
  };
  hud._cache = { dead: false, dying: false, spectatorKey: null };
  hud._spectatorTarget = null;
  hud._deathKiller = '';
  hud._el = {
    death: {
      style: {},
      classList: { toggle() {} },
    },
    deathMain: { textContent: '' },
    deathKiller: { textContent: '' },
  };

  hud._updateDeath('live');

  assert.match(hud._el.deathMain.textContent, /^SPECTATING /);
  assert.doesNotMatch(hud._el.deathMain.textContent, /OPERATIVE\s*2?$/);
});
