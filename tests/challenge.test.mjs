import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSwing, pitchDuration } from '../js/challenge-model.mjs';
test('early and late swings give actionable feedback and break combos', () => {
  assert.match(judgeSwing(-.4, 5).hint, /まって/);
  assert.match(judgeSwing(.4, 5).hint, /はやく/);
  assert.equal(judgeSwing(.4, 5).combo, 0);
  assert.equal(judgeSwing(.4, 5).points, 0);
});
test('accurate timing earns home runs and bounded streak bonuses', () => {
  assert.equal(judgeSwing(0).points, 300);
  assert.equal(judgeSwing(.15).kind, 'hit');
  assert.equal(judgeSwing(-.1, 3).points, 450);
  assert.equal(judgeSwing(0, 99).points, 550);
  assert.equal(judgeSwing(.24).kind, 'miss');
});
test('opening pitches are consistent before speeds vary', () => {
  assert.equal(pitchDuration(0), pitchDuration(1));
  assert.ok(new Set(Array.from({length:10}, (_, i) => pitchDuration(i))).size > 1);
});
