const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use DATA_DIR env var (Railway volume) if set, otherwise fallback to local (dev)
const dataDir = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'essaim.db');
console.log(`[db] Using database at: ${dbPath}`);

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_name TEXT NOT NULL,
    description TEXT NOT NULL,
    keywords TEXT NOT NULL,
    subreddits TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    reddit_post_id TEXT NOT NULL UNIQUE,
    subreddit TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT NOT NULL,
    author TEXT,
    relevance_score INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending',
    detected_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_id INTEGER NOT NULL,
    style TEXT NOT NULL,
    text TEXT NOT NULL,
    anti_ban_score INTEGER DEFAULT 7,
    tips TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (opportunity_id) REFERENCES opportunities(id)
  );

  CREATE TABLE IF NOT EXISTS seen_posts (
    reddit_post_id TEXT PRIMARY KEY,
    seen_at TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = db;
