/* quorb · shared/format 单元测试（node --test，无浏览器依赖） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmt, fmtSyncTime, resetText, bindingPct, bindingWin, thresholdCls } from '../../src/shared/format.js';

test('fmt：千分位与空值', () => {
  assert.equal(fmt(22600), '22,600');
  assert.equal(fmt(0), '0');
  assert.equal(fmt(null), '—');
  assert.equal(fmt(undefined), '—');
});

test('fmtSyncTime：今天 / 跨天', () => {
  const noon = new Date();
  noon.setHours(12, 34, 0, 0);
  assert.equal(fmtSyncTime(noon.getTime()), '今天 12:34');
  assert.equal(fmtSyncTime(0), '尚未同步');
  const yesterday = new Date(noon.getTime() - 864e5);
  assert.match(fmtSyncTime(yesterday.getTime()), /^\d{2}-\d{2} 12:34$/);
});

test('resetText：滚动窗口倒计时', () => {
  const now = Date.now();
  const slack = 2e4;   // 抵消测试取时与函数内部 Date.now() 的毫秒差，避免分钟取整边界抖动
  assert.equal(resetText({ kind: 'rolling', resetAt: now + 2 * 3.6e6 + 13 * 6e4 + slack }), '2h 13m 后重置');
  assert.equal(resetText({ kind: 'rolling', resetAt: now + 40 * 6e4 + slack }), '40 分钟后重置');
  assert.equal(resetText({ kind: 'rolling', resetAt: now - 1000 }), '已重置 · 等待下次同步');
  assert.equal(resetText({ kind: 'rolling' }), '');
});

test('resetText：固定周期显示时点与天数', () => {
  const now = new Date(2026, 10, 1, 9, 0, 0, 0);
  const target = new Date(now.getTime());
  target.setDate(target.getDate() + 3);
  target.setHours(18, 16, 0, 0);
  const out = resetText({ kind: 'fixed', resetAt: target.getTime() }, now.getTime());
  assert.match(out, /18:16/);
  assert.match(out, /3 天/);
});

test('bindingPct / bindingWin：最紧窗口', () => {
  const wins = [
    { id: 'week', pct: 38 },
    { id: 'h5', pct: 35 },
    { pct: null },
  ];
  assert.equal(bindingPct(wins), 35);
  assert.equal(bindingWin(wins).id, 'h5');
  assert.equal(bindingPct([]), null);
  assert.equal(bindingPct([{ pct: null }]), null);
  assert.equal(bindingWin([]), undefined);
});

test('thresholdCls：阈值边界（≤20 crit · 21–45 warn · >45 无色）', () => {
  assert.equal(thresholdCls(100), '');
  assert.equal(thresholdCls(46), '');
  assert.equal(thresholdCls(45), 'warn');
  assert.equal(thresholdCls(21), 'warn');
  assert.equal(thresholdCls(20), 'crit');
  assert.equal(thresholdCls(0), 'crit');
  assert.equal(thresholdCls(null), '');
});
