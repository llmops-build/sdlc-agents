CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                    -- workflow instance ID
    issue_number INTEGER NOT NULL,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    issue_title TEXT NOT NULL,
    issue_body TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    branch_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending|planning|coding|awaiting_approval|completed|failed
    plan TEXT,
    revision_count INTEGER DEFAULT 0,
    error_message TEXT,
    cost_usd REAL DEFAULT 0.0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS step_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    step_name TEXT NOT NULL,
    status TEXT NOT NULL,
    input_summary TEXT,
    output_summary TEXT,
    duration_ms INTEGER,
    cost_usd REAL DEFAULT 0.0,
    created_at TEXT DEFAULT (datetime('now'))
);
