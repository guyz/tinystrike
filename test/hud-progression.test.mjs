import assert from 'node:assert/strict';
import test from 'node:test';

import HUD from '../src/ui/hud.js';

function fakeElement() {
  const classes = new Set();
  const attributes = new Map();
  return {
    textContent: '',
    innerHTML: '',
    style: {},
    value: '',
    hidden: false,
    disabled: false,
    open: false,
    attributes,
    classes,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    focus() { this.focused = true; },
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      toggle(name, active) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
    },
  };
}

function progression(overrides = {}) {
  return {
    playerId: 'player-self',
    xp: 1_234,
    level: 3,
    tier: { id: 'bronze', name: 'Bronze', minLevel: 5 },
    xpIntoLevel: 84,
    xpForNextLevel: 800,
    records: {},
    achievements: [],
    achievementCount: 3,
    achievementTotal: 12,
    dailyContract: {
      title: 'Daily Bot Ops',
      description: 'Complete today’s bot contract.',
      targets: { matches: 3, wins: 2, kills: 20 },
      progress: { matches: 1, wins: 2, kills: 10 },
      completed: false,
      rewardXp: 250,
    },
    standing: {
      id: 'player-self',
      name: 'Career Ace',
      score: 1_234,
      ranks: { humans: 21, bots: 4, overall: 7 },
      scores: { humans: 380, bots: 854, overall: 1_234 },
    },
    ...overrides,
  };
}

function hudFor(progressionValue) {
  const hud = Object.create(HUD.prototype);
  hud.game = {
    profile: {
      get: () => ({ callsign: 'Fallback Ace', appearanceId: 'vanguard' }),
    },
    leaderboard: {
      playerId: 'player-self',
      getProgression: () => progressionValue,
      getIdentityStatus: () => 'ready',
    },
  };
  hud._lastProgression = null;
  hud._lastReward = null;
  hud._leaderboardCategory = 'overall';
  return hud;
}

test('career card renders saved rank, XP, daily bot incentive, and escaped server text', () => {
  const data = progression({
    tier: { id: 'bronze', name: '<Elite & Dangerous>' },
    standing: {
      id: 'player-self',
      name: '<img src=x onerror=alert(1)>',
      score: 1_234,
      ranks: { humans: 21, bots: 4, overall: 7 },
      scores: { humans: 380, bots: 854, overall: 1_234 },
    },
    dailyContract: {
      title: '<Daily & Dangerous>',
      description: '<script>stealCareer()</script>',
      targets: { matches: 3, wins: 2, kills: 20 },
      progress: { matches: 1, wins: 2, kills: 10 },
      completed: false,
      rewardXp: 250,
    },
  });
  const hud = hudFor(data);
  const botMain = fakeElement();
  const botSub = fakeElement();
  const botCta = fakeElement();
  botCta.querySelector = (selector) => selector === '.btn-main' ? botMain : botSub;
  hud._el = {
    careerName: fakeElement(),
    careerTier: fakeElement(),
    careerOverall: fakeElement(),
    careerBots: fakeElement(),
    careerScore: fakeElement(),
    careerXpFill: fakeElement(),
    careerXpLabel: fakeElement(),
    careerSync: fakeElement(),
    dailyTitle: fakeElement(),
    dailyDescription: fakeElement(),
    dailyProgress: fakeElement(),
    dailyFill: fakeElement(),
    dailyReward: fakeElement(),
    botCta,
    leaderboardSelf: fakeElement(),
    careerPodium: fakeElement(),
    careerRival: fakeElement(),
  };

  hud._renderCareer(data);
  hud._renderCareerPodium([
    { playerId: 'rival', playerName: '<script>rival()</script>', rank: 1, score: 9_999 },
  ]);

  assert.equal(hud._el.careerName.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(hud._el.careerTier.textContent, '<ELITE & DANGEROUS> · LEVEL 3');
  assert.equal(hud._el.careerOverall.textContent, '#7');
  assert.equal(hud._el.careerBots.textContent, '#4');
  assert.match(hud._el.careerScore.textContent, /1.234|1,234/);
  assert.equal(hud._el.careerXpFill.style.width, '10.5%');
  assert.match(hud._el.careerXpLabel.textContent, /84 \/ 800 XP TO LEVEL 4/);
  assert.equal(hud._el.careerSync.textContent, 'CAREER SAVED · 3/12 ACHIEVEMENTS');
  assert.equal(hud._el.dailyTitle.textContent, '<Daily & Dangerous>');
  assert.equal(hud._el.dailyDescription.textContent, '<script>stealCareer()</script>');
  assert.match(hud._el.dailyProgress.textContent, /1\/3 MATCHES.*2\/2 WINS.*10\/20 KILLS/);
  assert.equal(hud._el.dailyFill.style.width, '52.0%');
  assert.equal(hud._el.dailyReward.textContent, '+250 BONUS XP');
  assert.equal(botMain.textContent, 'PLAY DAILY BOT OPS');
  assert.equal(botSub.textContent, 'NO WAITING · START NOW');

  assert.doesNotMatch(hud._el.leaderboardSelf.innerHTML, /<ELITE|<script|<img/i);
  assert.match(hud._el.leaderboardSelf.innerHTML, /&lt;ELITE &amp; DANGEROUS&gt;/);
  assert.doesNotMatch(hud._el.careerPodium.innerHTML, /<script>/i);
  assert.match(hud._el.careerPodium.innerHTML, /&lt;script&gt;rival\(\)&lt;\/script&gt;/i);
});

test('end screen visualizes match points, rank climb, level-up, records, and achievements safely', () => {
  const data = progression({
    level: 5,
    tier: { id: 'bronze', name: 'Bronze' },
    xpIntoLevel: 300,
    xpForNextLevel: 1_100,
    standing: {
      id: 'player-self', name: 'Career Ace', score: 1_234,
      ranks: { humans: 20, bots: 3, overall: 6 },
      scores: { humans: 380, bots: 854, overall: 1_234 },
    },
  });
  const hud = hudFor(data);
  hud._el = {
    endRewards: fakeElement(),
    endRewardPoints: fakeElement(),
    endRewardRank: fakeElement(),
    endRewardLevel: fakeElement(),
    endXpFill: fakeElement(),
    endXpLabel: fakeElement(),
    endUnlocks: fakeElement(),
    endRank: fakeElement(),
  };
  hud._el.endRewards.classes.add('pending');
  const response = {
    result: { points: { humans: 0, bots: 187, overall: 187 } },
    rewards: {
      xpEarned: 437,
      scoreAfter: 1_234,
      rankBefore: 9,
      rankAfter: 6,
      levelBefore: 4,
      levelAfter: 5,
      tierAfter: { id: 'bronze', name: 'Bronze' },
      newAchievements: [{ title: '<script>achievement()</script>' }],
      newRecords: [{ label: '<img src=x onerror=record()>' }],
    },
    progression: data,
  };

  hud._renderEndRewards(response);

  assert.equal(hud._el.endRewards.classes.has('pending'), false);
  assert.equal(hud._el.endRewardPoints.textContent, '+187');
  assert.equal(hud._el.endRewardRank.textContent, '#9 → #6');
  assert.equal(hud._el.endRewardLevel.textContent, 'LEVEL 4 → 5 · BRONZE');
  assert.equal(hud._el.endXpFill.style.width, '27.3%');
  assert.match(hud._el.endXpLabel.textContent, /\+437 XP.*300\/1.100|\+437 XP.*300\/1,100/);
  assert.doesNotMatch(hud._el.endUnlocks.innerHTML, /<script>|<img/i);
  assert.match(hud._el.endUnlocks.innerHTML, /&lt;script&gt;achievement\(\)&lt;\/script&gt;/i);
  assert.match(hud._el.endUnlocks.innerHTML, /&lt;img src=x onerror=record\(\)&gt;/i);
});

test('global board identifies self by playerId, escapes duplicate callsigns, and pins an omitted self row', () => {
  const data = progression({
    standing: {
      id: 'player-self',
      name: '<Twin & Ace>',
      score: 450,
      ranks: { humans: null, bots: 41, overall: 77 },
      scores: { humans: 0, bots: 450, overall: 450 },
    },
  });
  const hud = hudFor(data);
  hud._el = { leaderboardBody: fakeElement() };
  const row = (playerId, rank, score) => ({
    playerId,
    playerName: '<Twin & Ace>',
    rank,
    score,
    wins: 2,
    matches: 4,
    kills: 12,
    deaths: 6,
    winRate: 50,
  });

  hud._renderLeaderboard([row('other-player', 12, 700), row('player-self', 77, 450)]);
  const withSelf = hud._el.leaderboardBody.innerHTML;
  assert.equal((withSelf.match(/class="lb-you"/g) || []).length, 1);
  assert.equal((withSelf.match(/class="lb-row rank-77 self"/g) || []).length, 1);
  assert.doesNotMatch(withSelf, /<Twin/i);
  assert.match(withSelf, /&lt;Twin &amp; Ace&gt;/);

  hud._renderLeaderboard([row('other-player', 12, 700)]);
  const pinned = hud._el.leaderboardBody.innerHTML;
  assert.match(pinned, /class="lb-row rank-77 self pinned-self"/);
  assert.match(pinned, /#77/);
  assert.match(pinned, /class="lb-you">YOU/);
  assert.doesNotMatch(pinned, /<Twin/i);
});

test('career dossier shows formatted personal bests, earned badges, and an explicit escaped next goal', () => {
  const data = progression({
    records: {
      matchScore: { value: 1_423, mapId: '<dustyard>' },
      kd: { value: 4.125, mapId: 'neon_foundry' },
      fastestWin: { value: 123, mapId: 'harbor' },
    },
    achievements: [{
      id: 'first_match',
      title: '<script>badge()</script>',
      description: '<img src=x onerror=badge()>',
    }],
    nextAchievements: [{
      title: '<Next & Goal>',
      description: '<Finish it safely>',
      progress: { current: 9, target: 10 },
    }],
  });
  const hud = hudFor(data);
  hud._el = {
    careerRecords: fakeElement(),
    careerAchievements: fakeElement(),
    careerNextGoal: fakeElement(),
  };

  hud._renderCareerDossier(data);

  assert.match(hud._el.careerRecords.innerHTML, /BEST MATCH SCORE/);
  assert.match(hud._el.careerRecords.innerHTML, /1.423|1,423/);
  assert.match(hud._el.careerRecords.innerHTML, /4\.13/);
  assert.match(hud._el.careerRecords.innerHTML, /2:03/);
  assert.doesNotMatch(hud._el.careerRecords.innerHTML, /<dustyard>/i);
  assert.match(hud._el.careerRecords.innerHTML, /&lt;DUSTYARD&gt;/i);
  assert.doesNotMatch(hud._el.careerAchievements.innerHTML, /<script>|<img/i);
  assert.match(hud._el.careerAchievements.innerHTML, /&lt;script&gt;badge\(\)&lt;\/script&gt;/i);
  assert.equal(hud._el.careerNextGoal.textContent, 'NEXT: <NEXT & GOAL> · 9/10 — <Finish it safely>');
});

test('starting a fresh career requires the explicit confirmation step and refreshes the dossier', async () => {
  const fresh = progression({ playerId: 'fresh-player', xp: 0, level: 1 });
  let starts = 0;
  let rendered = null;
  const hud = hudFor(progression());
  hud.game.leaderboard = {
    getIdentityStatus: () => 'ready',
    async startFreshProgress() { starts++; },
    getProgression: () => fresh,
  };
  hud._el = {
    progressNew: fakeElement(),
    progressNewConfirm: fakeElement(),
    progressNewCommit: fakeElement(),
    progressStatus: fakeElement(),
  };
  hud._renderCareer = (value) => { rendered = value; };

  hud._setNewCareerConfirm(true);
  assert.equal(starts, 0, 'opening the warning must not reset anything');
  assert.equal(hud._el.progressNewConfirm.hidden, false);
  assert.equal(hud._el.progressNewConfirm.style.display, 'grid');
  assert.equal(hud._el.progressNewConfirm.attributes.get('aria-hidden'), 'false');

  await hud._startFreshCareer();
  assert.equal(starts, 1);
  assert.equal(rendered, fresh);
  assert.equal(hud._lastProgression, fresh);
  assert.equal(hud._el.progressNewConfirm.hidden, true);
  assert.equal(hud._el.progressNewConfirm.style.display, 'none');
  assert.match(hud._el.progressStatus.textContent, /NEW CAREER READY/);
  assert.equal(hud._el.progressNewCommit.disabled, false);
});

test('recovery-required identity expands and emphasizes the guarded new-career escape hatch', () => {
  const hud = hudFor(progression());
  hud.game.leaderboard.getIdentityStatus = () => 'recovery-required';
  hud._profileOpen = true;
  hud._el = {
    progressNewWrap: fakeElement(),
    progressNew: fakeElement(),
    progressDetails: fakeElement(),
  };

  hud._syncProgressRecoveryUi();

  assert.equal(hud._el.progressNewWrap.classes.has('recovery'), true);
  assert.equal(hud._el.progressNew.textContent, 'START NEW CAREER INSTEAD');
  assert.equal(hud._el.progressDetails.open, true);
});

test('progress milestone live region sits outside the hidden game layer and mobile labels stay readable', () => {
  const html = HUD.prototype._html.call({});
  const gameClose = html.indexOf('<div id="hud-flash"></div></div>');
  const toasts = html.indexOf('id="hud-progression-toasts"');
  assert.ok(gameClose >= 0 && toasts > gameClose, 'milestones must survive /hud-game being hidden');
  assert.match(html, /id="hud-career-dossier"/);
  assert.match(html, /id="hud-progress-new-commit"/);

  const css = HUD.prototype._css.call({});
  assert.match(css, /orientation:landscape[^}]+max-height:500px/);
  assert.match(css, /progress-toast-copy em[\s\S]{0,240}font-size:10px!important/);
});

test('unranked guest event renders a terminal no-credit state instead of pending verification', () => {
  const handlers = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    const hud = hudFor(progression());
    hud._endUnranked = false;
    hud.game.events = { on(name, handler) { handlers.set(name, handler); } };
    hud._el = {
      endRewards: fakeElement(),
      endRewardPoints: fakeElement(),
      endRewardRank: fakeElement(),
      endRewardLevel: fakeElement(),
      endXpFill: fakeElement(),
      endXpLabel: fakeElement(),
      endUnlocks: fakeElement(),
      endRank: fakeElement(),
    };
    hud._el.endRewards.classes.add('pending');

    hud._bindEvents();
    assert.equal(typeof handlers.get('leaderboard:unranked'), 'function');
    handlers.get('leaderboard:unranked')({ matchId: 'online-match' });

    assert.equal(hud._endUnranked, true);
    assert.equal(hud._el.endRewards.classes.has('pending'), false);
    assert.equal(hud._el.endRewardPoints.textContent, 'NO CREDIT');
    assert.equal(hud._el.endRewardRank.textContent, 'GUEST');
    assert.equal(hud._el.endRank.textContent, 'UNRANKED GUEST · NO LEADERBOARD CREDIT');
    assert.doesNotMatch(hud._el.endXpLabel.textContent, /VERIFYING|SYNCING/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('end primary action returns online players to rooms and only restarts solo matches locally', () => {
  let leaves = 0;
  const emitted = [];
  const hud = hudFor(progression());
  hud.game.events = { emit(name) { emitted.push(name); } };
  hud.game.multiplayer = { active: true, leaveRoomAndReturn() { leaves++; } };
  hud._stats = new Map([['You', { k: 1, d: 0 }]]);
  hud._networkStatsById = new Map();
  hud._clearFeed = () => {};
  hud._setEndRank = () => {};
  hud._el = { restartMain: fakeElement(), restartSub: fakeElement() };

  hud._configureEndPrimaryAction();
  assert.equal(hud._el.restartMain.textContent, 'RETURN TO LOBBY');
  assert.equal(hud._el.restartSub.textContent, 'ROOM DIRECTORY');
  hud._handleEndPrimaryAction();
  assert.equal(leaves, 1);
  assert.deepEqual(emitted, []);

  hud.game.multiplayer.active = false;
  hud._configureEndPrimaryAction();
  assert.equal(hud._el.restartMain.textContent, 'PLAY AGAIN');
  assert.equal(hud._el.restartSub.textContent, 'SAME MAP · VS BOTS');
  hud._handleEndPrimaryAction();
  assert.deepEqual(emitted, ['ui:restart']);
});
