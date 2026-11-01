import test from 'node:test';
import assert from 'node:assert/strict';
import { decideTap, computeVisits, summarize, validateFix, localTimeToMs, needsReminder, localDay, halfOfDay } from '../src/logic.js';

const R4 = { id: 'r4', kind: 'room', label: 'Room 4' };
const R5 = { id: 'r5', kind: 'room', label: 'Room 5' };
const DICT = { id: 'd', kind: 'dictation', label: 'Dictation' };
const END = { id: 'e', kind: 'endday', label: 'End' };
const M = 60000;
const T0 = Date.UTC(2026, 9, 31, 15, 0); // 10:00 Central (CDT)

// tiny in-memory simulator mirroring the worker
function sim(taps) {
  const events = []; let id = 1;
  for (const [tag, at] of taps) {
    const last = events.filter(e => localDay(e.ts) === localDay(at)).at(-1) || null;
    const r = decideTap({ last, tag, now: at });
    for (const e of r.events) events.push({ id: id++, ts: at, day: localDay(at), ...e });
  }
  return events;
}

test('in then out of same room', () => {
  const ev = sim([[R4, T0], [R4, T0 + 12 * M]]);
  const { visits } = computeVisits(ev);
  assert.equal(visits.length, 1);
  assert.equal(visits[0].roomMs, 12 * M);
  assert.equal(visits[0].status, 'ok');
});

test('forgot tap-out: next room closes previous as inferred; over cutoff goes to review', () => {
  const ev = sim([[R4, T0], [R5, T0 + 50 * M], [R5, T0 + 60 * M]]);
  const { visits } = computeVisits(ev);
  assert.equal(visits[0].inferred, 1);
  assert.equal(visits[0].status, 'review');
  assert.equal(visits[0].counted, false);
  assert.equal(visits[1].roomMs, 10 * M);
  assert.equal(summarize(visits).avgRoomMs, 10 * M);
});

test('inferred under cutoff still counts', () => {
  const ev = sim([[R4, T0], [R5, T0 + 20 * M], [R5, T0 + 25 * M]]);
  const { visits } = computeVisits(ev);
  assert.equal(visits[0].counted, true);
});

test('dictation tied to last room, ends at next room tap', () => {
  const ev = sim([[R4, T0], [DICT, T0 + 10 * M], [R5, T0 + 16 * M], [R5, T0 + 25 * M]]);
  const { visits } = computeVisits(ev);
  assert.equal(visits[0].roomMs, 10 * M);
  assert.equal(visits[0].dictMs, 6 * M);
  assert.equal(visits[0].dictCounted, true);
});

test('dictation tap twice ends dictation', () => {
  const ev = sim([[R4, T0], [R4, T0 + 8 * M], [DICT, T0 + 9 * M], [DICT, T0 + 14 * M]]);
  const { visits } = computeVisits(ev);
  assert.equal(visits[0].roomMs, 8 * M);
  assert.equal(visits[0].dictMs, 5 * M);
});

test('end-of-day with open room is flagged inferred, unclosed day tail stays out of averages', () => {
  const ev = sim([[R4, T0], [END, T0 + 90 * M]]);
  const { visits } = computeVisits(ev);
  assert.equal(visits[0].status, 'review');
});

test('visit never closed = unclosed, excluded', () => {
  const ev = sim([[R4, T0]]);
  const { visits } = computeVisits(ev);
  assert.equal(visits[0].status, 'unclosed');
  assert.equal(summarize(visits).counted, 0);
});

test('duplicate tap within 5s ignored', () => {
  const ev = sim([[R4, T0], [R4, T0 + 2000]]);
  assert.equal(ev.length, 1);
});

test('fixed exit time makes a flagged visit count', () => {
  const ev = sim([[R4, T0], [R5, T0 + 50 * M]]);
  ev.find(e => e.action === 'OUT').ts = T0 + 15 * M;
  ev.find(e => e.action === 'OUT').fixed = 1;
  const { visits } = computeVisits(ev);
  assert.equal(visits[0].counted, true);
  assert.equal(visits[0].roomMs, 15 * M);
});

test('validateFix', () => {
  assert.match(validateFix({ inMs: 100, nextMs: 500, newOut: 50, nowMs: 1000 }), /after entry/);
  assert.match(validateFix({ inMs: 100, nextMs: 500, newOut: 600, nowMs: 1000 }), /next recorded/);
  assert.match(validateFix({ inMs: 100, nextMs: null, newOut: 2000, nowMs: 1000 }), /future/);
  assert.equal(validateFix({ inMs: 100, nextMs: 500, newOut: 300, nowMs: 1000 }), null);
});

test('localTimeToMs round-trips in Central incl. DST', () => {
  assert.equal(localTimeToMs('2026-10-31', '10:00'), T0);
  assert.equal(localTimeToMs('2026-11-02', '10:00'), Date.UTC(2026, 10, 2, 16, 0)); // CST after fall-back
  assert.ok(Number.isNaN(localTimeToMs('2026-10-31', '25:00')));
});

test('reminder rules', () => {
  const last = { id: 7, action: 'IN', ts: T0 };
  assert.equal(needsReminder({ last, now: T0 + 34 * M }), false);
  assert.equal(needsReminder({ last, now: T0 + 36 * M }), true);
  assert.equal(needsReminder({ last, now: T0 + 36 * M, remindedIds: new Set([7]) }), false);
  assert.equal(needsReminder({ last: { id: 8, action: 'OUT', ts: T0 }, now: T0 + 60 * M }), false);
  const late = Date.UTC(2026, 10, 1, 1, 0); // 8pm CDT/7pm CST... outside hours
  assert.equal(needsReminder({ last: { id: 9, action: 'IN', ts: late - 40 * M }, now: late }), false);
});

test('half of day', () => {
  assert.equal(halfOfDay(T0), 'AM');
  assert.equal(halfOfDay(T0 + 4 * 60 * M), 'PM');
});
