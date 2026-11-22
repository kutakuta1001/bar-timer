/*
 * タイマーの計算部分。画面や音には触れず、時刻（ミリ秒）を受け取って状態を返すだけにしてある。
 * ブラウザでは window.TimerCore、Node では require() で同じものを使う。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimerCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_SEC = 199 * 60 + 59;      // 設定・計測の上限 199:59
  var MAX_ROUNDS = 99;
  var HALF_MIN_MS = 10 * 1000;      // これより短い計測では「半分」の通知を出さない
  var UP_LAP_MS = 60 * 60 * 1000;   // カウントアップ時、バーが 1 周する時間
  var BLOCKS = 20;                  // バーの区画数（4 色 x 5 区画）

  function clampInt(v, min, max, fallback) {
    var n = Math.floor(Number(v));
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function defaultConfig() {
    return {
      mode: 'normal',   // 'normal' | 'repeat'
      setSec: 5 * 60,   // 通常計測の設定時間。0 ならカウントアップ
      workSec: 25 * 60, // リピート計測の作業時間
      breakSec: 5 * 60, // リピート計測の休憩時間
      rounds: 4,        // リピート回数
      half: true,       // 半分の時点で通知するか
      sound: true,      // 音を鳴らすか
      dim: 3            // 明るさ 1(暗)〜3(明)
    };
  }

  // 保存データは壊れている前提で読む。おかしな値は既定値に戻す。
  function normalizeConfig(raw) {
    var d = defaultConfig();
    if (!raw || typeof raw !== 'object') return d;
    return {
      mode: raw.mode === 'repeat' ? 'repeat' : 'normal',
      setSec: clampInt(raw.setSec, 0, MAX_SEC, d.setSec),
      workSec: clampInt(raw.workSec, 1, MAX_SEC, d.workSec),
      breakSec: clampInt(raw.breakSec, 1, MAX_SEC, d.breakSec),
      rounds: clampInt(raw.rounds, 1, MAX_ROUNDS, d.rounds),
      half: raw.half !== false,
      sound: raw.sound !== false,
      dim: clampInt(raw.dim, 1, 3, d.dim)
    };
  }

  function normalizeRun(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.status !== 'running' && raw.status !== 'paused') return null;
    if (raw.kind !== 'down' && raw.kind !== 'up') return null;
    if (['single', 'work', 'break'].indexOf(raw.phase) < 0) return null;
    var nums = ['durMs', 'startedAt', 'banked', 'round', 'rounds', 'workMs', 'breakMs'];
    for (var i = 0; i < nums.length; i++) {
      if (typeof raw[nums[i]] !== 'number' || !isFinite(raw[nums[i]]) || raw[nums[i]] < 0) return null;
    }
    if (raw.durMs <= 0) return null;
    return {
      status: raw.status, kind: raw.kind, phase: raw.phase,
      round: raw.round, rounds: raw.rounds,
      workMs: raw.workMs, breakMs: raw.breakMs,
      half: raw.half === true, halfDone: raw.halfDone === true,
      durMs: raw.durMs, startedAt: raw.startedAt, banked: raw.banked
    };
  }

  function start(config, now) {
    var base = {
      status: 'running', kind: 'down', phase: 'single',
      round: 1, rounds: 1, workMs: 0, breakMs: 0,
      half: config.half === true, halfDone: false,
      durMs: 0, startedAt: now, banked: 0
    };
    if (config.mode === 'repeat') {
      base.phase = 'work';
      base.rounds = config.rounds;
      base.workMs = Math.max(1, config.workSec) * 1000;
      base.breakMs = Math.max(1, config.breakSec) * 1000;
      base.durMs = base.workMs;
    } else if (config.setSec > 0) {
      base.durMs = config.setSec * 1000;
    } else {
      base.kind = 'up';
      base.durMs = MAX_SEC * 1000;
    }
    return base;
  }

  function copy(run, changes) {
    var out = {};
    for (var k in run) out[k] = run[k];
    for (var c in changes) out[c] = changes[c];
    return out;
  }

  // 一時停止までに進んだ分（banked）と、今走っている分を足した経過時間。
  function elapsed(run, now) {
    var live = run.status === 'running' ? Math.max(0, now - run.startedAt) : 0;
    return run.banked + live;
  }

  function pause(run, now) {
    if (run.status !== 'running') return run;
    return copy(run, { status: 'paused', banked: elapsed(run, now) });
  }

  function resume(run, now) {
    if (run.status !== 'paused') return run;
    return copy(run, { status: 'running', startedAt: now });
  }

  function halfEligible(run) {
    return run.half && run.kind === 'down' && run.phase !== 'break' && run.durMs >= HALF_MIN_MS;
  }

  /*
   * 現在時刻まで状態を進め、その間に起きた出来事を返す。
   * 画面が裏に回っていて長い時間が空いた場合も、区間をまたいで正しい位置まで進める。
   * events: {type:'half'} / {type:'phase', phase, round} / {type:'done'}
   */
  function advance(run, now) {
    var events = [];
    if (!run || run.status !== 'running') return { run: run, events: events };
    var r = run;
    for (;;) {
      var e = elapsed(r, now);
      if (!r.halfDone && e >= r.durMs / 2) {
        // 終了まで一気に飛び越えたときは、半分の通知は出さない
        if (halfEligible(r) && e < r.durMs) events.push({ type: 'half' });
        r = copy(r, { halfDone: true });
      }
      if (e < r.durMs) break;

      var over = e - r.durMs;
      var lastWork = r.phase === 'work' && r.round >= r.rounds;
      if (r.kind === 'up' || r.phase === 'single' || lastWork) {
        r = copy(r, { status: 'done', banked: r.durMs });
        events.push({ type: 'done' });
        break;
      }
      // 次の区間は、前の区間が終わった瞬間から始まったことにする（ずれを溜めない）
      if (r.phase === 'work') {
        r = copy(r, { phase: 'break', durMs: r.breakMs, startedAt: now - over, banked: 0, halfDone: false });
      } else {
        r = copy(r, { phase: 'work', round: r.round + 1, durMs: r.workMs, startedAt: now - over, banked: 0, halfDone: false });
      }
      events.push({ type: 'phase', phase: r.phase, round: r.round });
    }
    return { run: r, events: events };
  }

  // 画面に出す値。sec は表示する秒数、fraction はバーの点灯割合（0〜1）。
  function view(run, now) {
    var e = Math.min(elapsed(run, now), run.durMs);
    var sec, fraction;
    if (run.kind === 'up') {
      sec = Math.min(MAX_SEC, Math.floor(e / 1000));
      fraction = run.status === 'done' ? 1 : (e % UP_LAP_MS) / UP_LAP_MS;
    } else {
      var remain = run.durMs - e;
      sec = Math.ceil(remain / 1000);   // 切り上げ: 開始直後は設定時間そのまま、0 になるのは終了の瞬間
      fraction = remain / run.durMs;
    }
    return {
      status: run.status, kind: run.kind, phase: run.phase,
      round: run.round, rounds: run.rounds, sec: sec, fraction: fraction
    };
  }

  // 各区画の点灯量（0〜1）。左から順に満ち、端の 1 区画だけが中間値になる。
  function levels(fraction, count) {
    var n = count || BLOCKS;
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(Math.min(1, Math.max(0, fraction * n - i)));
    }
    return out;
  }

  function splitTime(sec) {
    var s = Math.min(MAX_SEC, Math.max(0, Math.floor(sec)));
    return { min: Math.floor(s / 60), sec: s % 60 };
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatTime(sec) {
    var t = splitTime(sec);
    return pad2(t.min) + ':' + pad2(t.sec);
  }

  return {
    MAX_SEC: MAX_SEC, MAX_ROUNDS: MAX_ROUNDS, BLOCKS: BLOCKS,
    HALF_MIN_MS: HALF_MIN_MS, UP_LAP_MS: UP_LAP_MS,
    defaultConfig: defaultConfig, normalizeConfig: normalizeConfig, normalizeRun: normalizeRun,
    start: start, pause: pause, resume: resume, advance: advance,
    elapsed: elapsed, view: view, levels: levels,
    splitTime: splitTime, pad2: pad2, formatTime: formatTime
  };
});
