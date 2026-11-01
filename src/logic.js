// Pure logic: no I/O, so it can be tested with plain node.

export const DEFAULTS = {
  timezone: 'America/Chicago',
  cutoffMin: 45,        // inferred visits longer than this are excluded from averages
  dictCutoffMin: 45,    // same for dictation spans
  remindMin: 35,        // push reminder after this long with no tap
  clinicStartHour: 7,   // reminders only inside these local hours
  clinicEndHour: 18,
  dupMs: 5000,          // ignore a repeat tap on the same tag within this window
  minSurveyN: 5,        // hide survey aggregates below this many responses
};

export function localDay(ms, tz = DEFAULTS.timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
export function localMonth(ms, tz = DEFAULTS.timezone) { return localDay(ms, tz).slice(0, 7); }
export function localHour(ms, tz = DEFAULTS.timezone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
}
export function halfOfDay(ms, tz = DEFAULTS.timezone) { return localHour(ms, tz) < 12 ? 'AM' : 'PM'; }

/**
 * Decide what events a tap produces.
 * last: latest event today ({action, tag_id, room_label, ts}) or null
 * tag:  {id, kind: 'room'|'dictation'|'endday', label}
 * Returns { events: [{action, tag_id, room_label, inferred}], msg, dup }
 */
export function decideTap({ last, tag, now, dupMs = DEFAULTS.dupMs }) {
  if (last && last.tag_id === tag.id && now - last.ts < dupMs) {
    return { events: [], msg: 'Already recorded', dup: true };
  }
  const ev = [];
  const inRoom = last && last.action === 'IN';
  const inDict = last && last.action === 'DICT';
  const prev = (a, inferred = 0) => ({ action: a, tag_id: last.tag_id, room_label: last.room_label, inferred });

  if (tag.kind === 'room') {
    if (inRoom && last.tag_id === tag.id) {
      ev.push({ action: 'OUT', tag_id: tag.id, room_label: tag.label, inferred: 0 });
      return { events: ev, msg: `Out of ${tag.label}`, state: 'out' };
    }
    if (inRoom) ev.push(prev('OUT', 1));       // forgot to tap out of previous room
    if (inDict) ev.push(prev('DICT_END'));     // dictation ends when he walks into a room
    ev.push({ action: 'IN', tag_id: tag.id, room_label: tag.label, inferred: 0 });
    return { events: ev, msg: `In ${tag.label}`, state: 'in' };
  }

  if (tag.kind === 'dictation') {
    if (inDict) {
      ev.push(prev('DICT_END'));
      return { events: ev, msg: 'Dictation ended', state: 'dict_end' };
    }
    let room = null, tagId = tag.id;
    if (inRoom) {
      ev.push(prev('OUT', 0));
      room = last.room_label; tagId = last.tag_id;
    } else if (last && last.action === 'OUT') {
      room = last.room_label; tagId = last.tag_id;
    }
    // dictation is tied to the last room he was in
    ev.push({ action: 'DICT', tag_id: tagId, room_label: room, inferred: 0 });
    return { events: ev, msg: room ? `Dictating (${room})` : 'Dictating', state: 'dict' };
  }

  if (tag.kind === 'endday') {
    if (inRoom) ev.push(prev('OUT', 1));
    if (inDict) ev.push(prev('DICT_END', 1));
    ev.push({ action: 'END', tag_id: tag.id, room_label: null, inferred: 0 });
    return { events: ev, msg: 'Day closed', state: 'end' };
  }
  return { events: [], msg: 'Unknown tag' };
}

/**
 * Turn an ordered event list (one or many days) into visits.
 * Each visit: { id, day, room, start, end, roomMs, dictStart, dictEnd, dictMs,
 *   outId, inferred, fixed, status, counted, dictCounted }
 * status: 'ok' | 'review' (inferred, over cutoff) | 'unclosed'
 */
export function computeVisits(events, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const visits = [];
  let cur = null;            // open visit (IN seen, no OUT yet)
  let dictFor = null;        // visit that currently has open dictation
  const lastByRoom = new Map();
  const orphans = [];

  for (const e of events) {
    if (e.action === 'IN') {
      cur = { id: e.id, day: e.day, room: e.room_label, start: e.ts, end: null, outId: null, inferred: 0, fixed: 0,
              dictStart: null, dictEnd: null, dictEndInferred: 0 };
      visits.push(cur);
      lastByRoom.set(e.room_label, cur);
    } else if (e.action === 'OUT' && cur) {
      cur.end = e.ts; cur.outId = e.id; cur.inferred = e.inferred ? 1 : 0; cur.fixed = e.fixed ? 1 : 0;
      cur = null;
    } else if (e.action === 'DICT') {
      const v = lastByRoom.get(e.room_label);
      if (v && v.day === e.day && v.dictStart == null) { v.dictStart = e.ts; dictFor = v; }
      else { dictFor = { room: e.room_label, day: e.day, dictStart: e.ts, dictEnd: null, orphan: true }; orphans.push(dictFor); }
    } else if ((e.action === 'DICT_END') && dictFor) {
      dictFor.dictEnd = e.ts; dictFor.dictEndInferred = e.inferred ? 1 : 0; dictFor = null;
    }
  }

  const cutMs = o.cutoffMin * 60000, dCutMs = o.dictCutoffMin * 60000;
  for (const v of visits) {
    if (v.end == null) { v.status = 'unclosed'; v.roomMs = null; v.counted = false; }
    else {
      v.roomMs = v.end - v.start;
      const over = v.inferred && !v.fixed && v.roomMs > cutMs;
      v.status = over ? 'review' : 'ok';
      v.counted = !over;
    }
    v.dictMs = (v.dictStart != null && v.dictEnd != null) ? v.dictEnd - v.dictStart : null;
    v.dictCounted = v.dictMs != null && !(v.dictEndInferred && v.dictMs > dCutMs);
  }
  return { visits, orphans };
}

/** Average only the counted visits. */
export function summarize(visits) {
  const room = visits.filter(v => v.counted);
  const dict = visits.filter(v => v.dictCounted);
  const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  return {
    visits: visits.length,
    counted: room.length,
    needReview: visits.filter(v => v.status !== 'ok').length,
    avgRoomMs: avg(room.map(v => v.roomMs)),
    avgDictMs: avg(dict.map(v => v.dictMs)),
    totalRoomMs: room.reduce((s, v) => s + v.roomMs, 0),
    totalDictMs: dict.reduce((s, v) => s + v.dictMs, 0),
  };
}

/**
 * Validate a corrected exit time for a visit.
 * inMs: visit start; nextMs: ts of next event after the visit start (or null); newOut: proposed ms; nowMs.
 */
export function validateFix({ inMs, nextMs, newOut, nowMs }) {
  if (!Number.isFinite(newOut)) return 'Bad time';
  if (newOut <= inMs) return 'Exit must be after entry';
  if (newOut > nowMs) return 'Exit is in the future';
  if (nextMs != null && newOut > nextMs) return 'Exit is after the next recorded tap';
  return null;
}

/** Convert "HH:MM" on a given local day to epoch ms (handles DST by search). */
export function localTimeToMs(day, hhmm, tz = DEFAULTS.timezone) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return NaN;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return NaN;
  const [y, mo, d] = day.split('-').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
    const g = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const asUtc = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour, +g.minute);
    const diff = Date.UTC(y, mo - 1, d, h, mi) - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** Should a reminder go out? last is the latest event overall. */
export function needsReminder({ last, now, remindedIds = new Set(), opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  if (!last || (last.action !== 'IN' && last.action !== 'DICT')) return false;
  if (remindedIds.has(last.id)) return false;
  if (localDay(last.ts, o.timezone) !== localDay(now, o.timezone)) return false;
  const h = localHour(now, o.timezone);
  if (h < o.clinicStartHour || h >= o.clinicEndHour) return false;
  return now - last.ts >= o.remindMin * 60000;
}
