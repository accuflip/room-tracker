-- Room Time Tracker schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  slug       TEXT UNIQUE NOT NULL,          -- unguessable token that goes in the NFC URL
  kind       TEXT NOT NULL CHECK (kind IN ('room','dictation','endday','survey')),
  label      TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Physician's visit log. Contains NO patient information, only rooms and times.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,              -- epoch ms
  day        TEXT NOT NULL,                 -- local clinic day, YYYY-MM-DD
  action     TEXT NOT NULL CHECK (action IN ('IN','OUT','DICT','DICT_END','END')),
  tag_id     TEXT,
  room_label TEXT,
  inferred   INTEGER NOT NULL DEFAULT 0,    -- 1 = closed by a later tap, not by him
  fixed      INTEGER NOT NULL DEFAULT 0     -- 1 = time corrected by him afterward
);
CREATE INDEX IF NOT EXISTS idx_events_day ON events (day, ts, id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts, id);

-- Patient survey. Deliberately SEPARATE from events and carries no room, no time of day
-- beyond month + AM/PM, and no identifiers, so it cannot be matched to a visit.
CREATE TABLE IF NOT EXISTS survey_responses (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  month   TEXT NOT NULL,                    -- YYYY-MM
  half    TEXT NOT NULL CHECK (half IN ('AM','PM')),
  answers TEXT NOT NULL                     -- JSON {"q1":4,...}
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,              -- SHA-256 of the cookie value
  expires    INTEGER NOT NULL,
  role       TEXT NOT NULL DEFAULT 'doctor' -- 'doctor' or 'ma'
);

-- Patient waits. Room and time only: no names, initials or any patient identifier.
CREATE TABLE IF NOT EXISTS room_waits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_tag_id TEXT NOT NULL,
  room_label  TEXT NOT NULL,
  day         TEXT NOT NULL,
  start_ts    INTEGER NOT NULL,             -- MA tapped the room card
  end_ts      INTEGER,                      -- doctor walked in, or the MA cleared it
  status      TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','seen','cancelled','expired'))
);
CREATE INDEX IF NOT EXISTS idx_waits_day ON room_waits (day, status);

CREATE TABLE IF NOT EXISTS login_fails (ts INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS push_tokens (
  token      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  event_id INTEGER PRIMARY KEY,
  sent_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
