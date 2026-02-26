-- Spawn: AI-driven software generation from natural language
CREATE TABLE spawns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  prompt TEXT NOT NULL,
  name TEXT,
  description TEXT,
  platform TEXT,
  features TEXT,        -- JSON array of feature strings
  architecture TEXT,    -- JSON object: file tree, tech stack, patterns
  stage TEXT NOT NULL DEFAULT 'seed',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE spawn_files (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  spawn_id TEXT NOT NULL REFERENCES spawns(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  language TEXT,
  stage TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(spawn_id, path)
);

CREATE TABLE spawn_stages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  spawn_id TEXT NOT NULL REFERENCES spawns(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  output TEXT,          -- JSON: AI reasoning, decisions made
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_spawn_files_spawn_id ON spawn_files(spawn_id);
CREATE INDEX idx_spawn_stages_spawn_id ON spawn_stages(spawn_id);
CREATE INDEX idx_spawns_status ON spawns(status);
