'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../docs/timer-core.js');

const T0 = 1_000_000;
const cfg = (over) => Object.assign(C.defaultConfig(), over);
const types = (events) => events.map((e) => e.type);

test('カウントダウン: 開始直後は設定時間、1.5 秒後は切り上げ表示', () => {
  const run = C.start(cfg({ setSec: 300 }), T0);
  assert.equal(C.view(run, T0).sec, 300);
  assert.equal(C.view(run, T0).fraction, 1);
  assert.equal(C.view(run, T0 + 1500).sec, 299);
  assert.equal(C.view(run, T0 + 150_000).fraction, 0.5);
});

test('カウントダウン: 半分で 1 回だけ通知し、終了で done になる', () => {
  let run = C.start(cfg({ setSec: 60 }), T0);
  let r = C.advance(run, T0 + 29_999);
  assert.deepEqual(r.events, []);
  r = C.advance(r.run, T0 + 30_000);
  assert.deepEqual(types(r.events), ['half']);
  r = C.advance(r.run, T0 + 31_000);
  assert.deepEqual(r.events, [], '半分の通知は繰り返さない');
  r = C.advance(r.run, T0 + 60_000);
  assert.deepEqual(types(r.events), ['done']);
  assert.equal(r.run.status, 'done');
  assert.equal(C.view(r.run, T0 + 99_000).sec, 0);
  assert.equal(C.view(r.run, T0 + 99_000).fraction, 0);
});

test('半分の通知: オフのとき、10 秒未満のときは出さない', () => {
  let r = C.advance(C.start(cfg({ setSec: 60, half: false }), T0), T0 + 40_000);
  assert.deepEqual(r.events, []);
  r = C.advance(C.start(cfg({ setSec: 9 }), T0), T0 + 5_000);
  assert.deepEqual(r.events, []);
  r = C.advance(C.start(cfg({ setSec: 10 }), T0), T0 + 5_000);
  assert.deepEqual(types(r.events), ['half']);
});

test('長く画面を離れて終了を飛び越えたら、通知は done だけ', () => {
  const r = C.advance(C.start(cfg({ setSec: 60 }), T0), T0 + 3_600_000);
  assert.deepEqual(types(r.events), ['done']);
});

test('一時停止中は進まず、再開後に続きから進む', () => {
  let run = C.start(cfg({ setSec: 100, half: false }), T0);
  run = C.pause(run, T0 + 40_000);
  assert.equal(run.status, 'paused');
  assert.equal(C.view(run, T0 + 999_000).sec, 60);
  assert.deepEqual(C.advance(run, T0 + 999_000).events, [], '停止中は何も起きない');
  run = C.resume(run, T0 + 500_000);
  assert.equal(C.view(run, T0 + 510_000).sec, 50);
  const r = C.advance(run, T0 + 560_000);
  assert.deepEqual(types(r.events), ['done']);
});

test('設定 0:00 で始めるとカウントアップになり、199:59 で止まる', () => {
  const run = C.start(cfg({ setSec: 0 }), T0);
  assert.equal(run.kind, 'up');
  assert.equal(C.view(run, T0).sec, 0);
  assert.equal(C.view(run, T0 + 61_900).sec, 61);
  assert.equal(C.view(run, T0 + 30 * 60_000).fraction, 0.5, 'バーは 60 分で 1 周');
  assert.deepEqual(C.advance(run, T0 + 60 * 60_000).events, [], 'カウントアップに半分の通知はない');
  const r = C.advance(run, T0 + C.MAX_SEC * 1000 + 5_000);
  assert.deepEqual(types(r.events), ['done']);
  assert.equal(C.view(r.run, T0 + C.MAX_SEC * 1000 + 5_000).sec, C.MAX_SEC);
});

test('リピート: 作業と休憩を交互に進め、最後の作業で終わる', () => {
  const config = cfg({ mode: 'repeat', workSec: 60, breakSec: 20, rounds: 2, half: false });
  let r = { run: C.start(config, T0), events: [] };
  assert.equal(r.run.phase, 'work');
  assert.equal(C.view(r.run, T0).round, 1);

  r = C.advance(r.run, T0 + 60_000);
  assert.deepEqual(r.events, [{ type: 'phase', phase: 'break', round: 1 }]);
  assert.equal(C.view(r.run, T0 + 60_000).sec, 20);

  r = C.advance(r.run, T0 + 80_000);
  assert.deepEqual(r.events, [{ type: 'phase', phase: 'work', round: 2 }]);
  assert.equal(C.view(r.run, T0 + 80_000).sec, 60);

  r = C.advance(r.run, T0 + 140_000);
  assert.deepEqual(types(r.events), ['done'], '最後の作業のあとに休憩は入らない');
  assert.equal(r.run.status, 'done');
});

test('リピート: 半分の通知は作業中だけ出る', () => {
  const config = cfg({ mode: 'repeat', workSec: 60, breakSec: 60, rounds: 2 });
  let r = C.advance(C.start(config, T0), T0 + 30_000);
  assert.deepEqual(types(r.events), ['half']);
  r = C.advance(r.run, T0 + 60_000);
  assert.deepEqual(types(r.events), ['phase']);
  r = C.advance(r.run, T0 + 95_000);
  assert.deepEqual(r.events, [], '休憩の半分では通知しない');
});

test('リピート: 遅れて確認しても区間の境目はずれない', () => {
  const config = cfg({ mode: 'repeat', workSec: 60, breakSec: 20, rounds: 3, half: false });
  // 作業 60 秒 + 休憩 20 秒 + 作業 2 回目の 15 秒目まで一気に進める
  const r = C.advance(C.start(config, T0), T0 + 95_000);
  assert.deepEqual(types(r.events), ['phase', 'phase']);
  const v = C.view(r.run, T0 + 95_000);
  assert.equal(v.phase, 'work');
  assert.equal(v.round, 2);
  assert.equal(v.sec, 45);
});

test('リピート 1 回は作業 1 本だけで終わる', () => {
  const config = cfg({ mode: 'repeat', workSec: 30, breakSec: 10, rounds: 1, half: false });
  const r = C.advance(C.start(config, T0), T0 + 30_000);
  assert.deepEqual(types(r.events), ['done']);
});

test('levels: 左から満ち、端の 1 区画だけが中間値', () => {
  assert.deepEqual(C.levels(1, 4), [1, 1, 1, 1]);
  assert.deepEqual(C.levels(0, 4), [0, 0, 0, 0]);
  assert.deepEqual(C.levels(0.625, 4), [1, 1, 0.5, 0]);
  assert.equal(C.levels(0.5).length, C.BLOCKS);
});

test('formatTime: 2 桁そろえ、100 分以上は 3 桁', () => {
  assert.equal(C.formatTime(0), '00:00');
  assert.equal(C.formatTime(65), '01:05');
  assert.equal(C.formatTime(C.MAX_SEC), '199:59');
  assert.equal(C.formatTime(999_999), '199:59');
});

test('保存データが壊れていても既定値で立ち上がる', () => {
  assert.deepEqual(C.normalizeConfig(null), C.defaultConfig());
  assert.deepEqual(C.normalizeConfig('x'), C.defaultConfig());
  const c = C.normalizeConfig({ mode: 'weird', setSec: -5, workSec: 0, rounds: 1e9, dim: 'a', sound: false });
  assert.equal(c.mode, 'normal');
  assert.equal(c.setSec, 0);
  assert.equal(c.workSec, 1);
  assert.equal(c.rounds, C.MAX_ROUNDS);
  assert.equal(c.dim, 3);
  assert.equal(c.sound, false);

  assert.equal(C.normalizeRun(null), null);
  assert.equal(C.normalizeRun({ status: 'done' }), null);
  assert.equal(C.normalizeRun({ status: 'running', kind: 'down', phase: 'single', durMs: 'x' }), null);
  const run = C.start(cfg({ setSec: 60 }), T0);
  assert.deepEqual(C.normalizeRun(JSON.parse(JSON.stringify(run))), run);
});
