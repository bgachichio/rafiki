-- Rafiki D1 schema. Idempotent: safe to apply on every deploy.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen_updates (update_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent_role TEXT, model TEXT, sens TEXT, provider_pref TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, ms INTEGER DEFAULT 0, status TEXT, trace TEXT);
CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, text TEXT NOT NULL, metric TEXT, target TEXT, by_date TEXT, state TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', done_ts INTEGER);
CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, text TEXT NOT NULL, due_ts INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', chase_count INTEGER NOT NULL DEFAULT 0, repeat TEXT NOT NULL DEFAULT 'none', last_sent_ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (state, due_ts);
CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, prospect TEXT NOT NULL UNIQUE, segment TEXT, rung INTEGER NOT NULL DEFAULT 0, next_ask TEXT, last_move_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spends (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, category TEXT, channel TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS idx_spends_ts ON spends (ts);
CREATE TABLE IF NOT EXISTS fee_tiers (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, min_cents INTEGER NOT NULL, max_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL, set_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbound (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, unsolicited INTEGER NOT NULL DEFAULT 0);

-- Memory v2: durable facts, summaries and full-text search over everything said. Nothing here is ever deleted automatically.
CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, text TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', source TEXT NOT NULL DEFAULT 'chat', pinned INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_text ON facts (lower(text));
INSERT INTO facts (ts, text, category, source) SELECT ts, text, 'other', 'chat' FROM notes WHERE lower(text) NOT IN (SELECT lower(text) FROM facts);
CREATE TABLE IF NOT EXISTS summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (kind, period));
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(kind, ref_id UNINDEXED, text, tokenize = 'porter unicode61');
INSERT INTO memory_fts (kind, ref_id, text) SELECT 'message', id, text FROM messages WHERE id NOT IN (SELECT ref_id FROM memory_fts WHERE kind = 'message');
INSERT INTO memory_fts (kind, ref_id, text) SELECT 'fact', id, text FROM facts WHERE id NOT IN (SELECT ref_id FROM memory_fts WHERE kind = 'fact');

-- Connections: encrypted credentials and a per-calendar cache (one row per calendar keeps D1 queries low).
CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, enc TEXT NOT NULL, meta TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cal_cache (cal_id TEXT PRIMARY KEY, name TEXT, json TEXT NOT NULL, ts INTEGER NOT NULL);

-- Media pack: stored files, locations, named places, polls.
CREATE TABLE IF NOT EXISTS docs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, name TEXT NOT NULL, mime TEXT, bytes INTEGER, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS locations (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, live INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS places (name TEXT PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS polls (poll_id TEXT PRIMARY KEY, question TEXT NOT NULL, options TEXT NOT NULL, ts INTEGER NOT NULL);

-- Preferences, imports, skills.
CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'chat', ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS imports (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL, counts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skills (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', version TEXT, source TEXT NOT NULL, hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL, nsections INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS skill_sections (id INTEGER PRIMARY KEY AUTOINCREMENT, skill_id INTEGER NOT NULL, heading TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_skill_sections_skill ON skill_sections (skill_id);

-- Feedback: a thumbs up or down under each brief and nudge.
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, vote INTEGER NOT NULL, msg_id INTEGER, excerpt TEXT NOT NULL DEFAULT '');

-- Decision cards, reminder rules and learning signals.
CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, key TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, proposed TEXT, chosen TEXT, custom TEXT, state TEXT NOT NULL DEFAULT 'open', done_ts INTEGER, multi INTEGER NOT NULL DEFAULT 0, poll_id TEXT, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS pref_state (key TEXT PRIMARY KEY, status TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reminder_policy (reminder_id INTEGER PRIMARY KEY, mode TEXT NOT NULL, gap_ms INTEGER NOT NULL, max_chase INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT);
CREATE INDEX IF NOT EXISTS idx_signals_kind ON signals (kind, ts);

-- Birthdays from imported contacts, for the morning brief.
CREATE TABLE IF NOT EXISTS birthdays (name TEXT NOT NULL, md TEXT NOT NULL, year INTEGER, PRIMARY KEY (name, md));
