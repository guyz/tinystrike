import assert from 'node:assert/strict';
import test from 'node:test';

import HUD from '../src/ui/hud.js';

function fakeElement() {
  const classes = new Set();
  return {
    textContent: '',
    disabled: false,
    offsetWidth: 100,
    classes,
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

function makeHud(buyResult) {
  const row = fakeElement();
  const funds = fakeElement();
  const feedback = fakeElement();
  const feedbackText = fakeElement();
  const owned = new Set();
  const state = { phase: 'freeze', canBuy: true, money: 8000 };
  const weapons = {
    currentId: 'usp',
    slots: { 4: [] },
    owns(id) { return owned.has(id); },
    buy(id) {
      if (!buyResult) return false;
      owned.add(id);
      this.currentId = id;
      state.money -= 3100;
      return true;
    },
  };

  const hud = Object.create(HUD.prototype);
  hud.game = {
    state,
    weapons,
    player: { alive: true, armor: 0, hasKit: false },
    config: { PLAYER: { MAX_ARMOR: 100 } },
  };
  hud._time = 10;
  hud._buyMoney = -1;
  hud._names = { m4a1: 'M4-A1' };
  hud._maxCarry = {};
  hud._buyRows = [{ id: 'm4a1', price: 3100, el: row, afford: null, owned: null, grenade: false }];
  hud._el = { buyFunds: funds, buyFeedback: feedback, buyFeedbackText: feedbackText };
  return { hud, state, row, funds, feedback, feedbackText };
}

test('a successful mobile purchase refreshes and confirms synchronously', () => {
  const { hud, state, row, funds, feedback, feedbackText } = makeHud(true);

  assert.equal(hud._tryBuy('m4a1'), true);
  assert.equal(state.money, 4900);
  assert.equal(funds.textContent, '$ 4900');
  assert.equal(row.disabled, true);
  assert.equal(row.classes.has('owned'), true);
  assert.equal(row.classes.has('purchased'), true);
  assert.equal(feedbackText.textContent, '✓ M4-A1 PURCHASED · EQUIPPED');
  assert.equal(feedback.classes.has('feedback-success'), true);
});

test('a rejected purchase shows explicit feedback without changing funds', () => {
  const { hud, state, row, funds, feedback, feedbackText } = makeHud(false);

  assert.equal(hud._tryBuy('m4a1'), false);
  assert.equal(state.money, 8000);
  assert.equal(funds.textContent, '$ 8000');
  assert.equal(row.disabled, false);
  assert.equal(feedbackText.textContent, 'PURCHASE UNAVAILABLE');
  assert.equal(feedback.classes.has('feedback-error'), true);
  assert.equal(feedback.classes.has('feedback-success'), false);
});
