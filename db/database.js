const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'theengine.db');
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT UNIQUE NOT NULL,
  title       TEXT,
  description TEXT,
  body_text   TEXT,
  crawled_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  status_code INTEGER,
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS links (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  from_url TEXT NOT NULL,
  to_url   TEXT NOT NULL,
  UNIQUE(from_url, to_url)
);

CREATE TABLE IF NOT EXISTS crawl_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  url        TEXT UNIQUE NOT NULL,
  priority   INTEGER DEFAULT 5,
  depth      INTEGER NOT NULL DEFAULT 0,
  added_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  attempted  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS word_index (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  word     TEXT NOT NULL,
  page_id  INTEGER NOT NULL,
  tf_score REAL,
  UNIQUE(word, page_id),
  FOREIGN KEY (page_id) REFERENCES pages(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSettingStmt = db.prepare(`
  INSERT INTO settings (key, value) VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getSetting(key, defaultValue = null) {
  const row = getSettingStmt.get(key);
  if (!row) return defaultValue;
  return row.value;
}

function setSetting(key, value) {
  upsertSettingStmt.run({ key, value: String(value) });
}

if (getSetting('crawl_mode') == null) {
  setSetting('crawl_mode', 'manual');
}
if (getSetting('crawl_max_depth') == null) {
  setSetting('crawl_max_depth', '2');
}

try {
  db.exec(`ALTER TABLE crawl_queue ADD COLUMN depth INTEGER NOT NULL DEFAULT 0`);
} catch (e) {
  if (!/duplicate column|already exists/i.test(String(e.message))) throw e;
}

const insertPageStmt = db.prepare(`
  INSERT INTO pages (url, title, description, body_text, status_code, content_hash)
  VALUES (@url, @title, @description, @bodyText, @statusCode, @contentHash)
  ON CONFLICT(url) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    body_text = excluded.body_text,
    crawled_at = CURRENT_TIMESTAMP,
    status_code = excluded.status_code,
    content_hash = excluded.content_hash
`);

const selectPageIdByUrl = db.prepare('SELECT id, content_hash FROM pages WHERE url = ?');

function insertPage(url, title, description, bodyText, statusCode, contentHash) {
  insertPageStmt.run({
    url,
    title: title || null,
    description: description || null,
    bodyText: bodyText || null,
    statusCode: statusCode ?? null,
    contentHash: contentHash || null,
  });
  const row = db.prepare('SELECT id FROM pages WHERE url = ?').get(url);
  return row.id;
}

const insertLinkStmt = db.prepare(`
  INSERT OR IGNORE INTO links (from_url, to_url) VALUES (?, ?)
`);

function insertLink(fromUrl, toUrl) {
  insertLinkStmt.run(fromUrl, toUrl);
}

const enqueueStmt = db.prepare(`
  INSERT OR IGNORE INTO crawl_queue (url, priority, depth) VALUES (?, ?, ?)
`);

function enqueueUrl(url, priority = 5, depth = 0) {
  enqueueStmt.run(url, priority, depth);
}

function enqueueUrls(urls, priority = 5, depth = 0) {
  let inserted = 0;
  for (const raw of urls) {
    const u = String(raw || '').trim();
    if (!u) continue;
    const info = enqueueStmt.run(u, priority, depth);
    if (info.changes > 0) inserted += 1;
  }
  return inserted;
}

const upsertQueuePriorityStmt = db.prepare(`
  INSERT INTO crawl_queue (url, priority, depth, attempted)
  VALUES (@url, @priority, @depth, 0)
  ON CONFLICT(url) DO UPDATE SET
    priority = excluded.priority,
    depth = excluded.depth
`);

function upsertQueueUrlsPriority(urls, priority, depth = 0) {
  let n = 0;
  const run = db.transaction((list) => {
    for (const raw of list) {
      const u = String(raw || '').trim();
      if (!u) continue;
      upsertQueuePriorityStmt.run({ url: u, priority, depth });
      n += 1;
    }
  });
  run(urls);
  return n;
}

const getNextStmt = db.prepare(`
  SELECT id, url, priority, depth, attempted FROM crawl_queue
  ORDER BY priority DESC, id ASC
  LIMIT 1
`);

function getNextInQueue() {
  return getNextStmt.get() || null;
}

const markAttemptedStmt = db.prepare(`
  UPDATE crawl_queue SET attempted = attempted + 1 WHERE url = ?
`);

function markAttempted(url) {
  markAttemptedStmt.run(url);
}

const removeFromQueueStmt = db.prepare(`DELETE FROM crawl_queue WHERE url = ?`);

function removeFromQueue(url) {
  removeFromQueueStmt.run(url);
}

function searchPages(words) {
  if (!words || words.length === 0) {
    return [];
  }
  const placeholders = words.map(() => '?').join(',');
  const sql = `
    SELECT
      p.id,
      p.url,
      p.title,
      p.description,
      p.crawled_at,
      SUM(w.tf_score) AS tf_sum
    FROM pages p
    INNER JOIN word_index w ON w.page_id = p.id AND w.word IN (${placeholders})
    GROUP BY p.id
    HAVING COUNT(DISTINCT w.word) = ?
  `;
  const params = [...words, words.length];
  return db.prepare(sql).all(...params);
}

function getStats() {
  const pageCount = db.prepare('SELECT COUNT(*) AS c FROM pages').get().c;
  const linkCount = db.prepare('SELECT COUNT(*) AS c FROM links').get().c;
  const queueSize = db.prepare('SELECT COUNT(*) AS c FROM crawl_queue').get().c;
  return { pageCount, linkCount, queueSize };
}

function getTotalIndexedPages() {
  return db.prepare('SELECT COUNT(*) AS c FROM pages WHERE body_text IS NOT NULL AND LENGTH(TRIM(body_text)) > 0').get().c;
}

function suggestTitles(query, limit = 5) {
  if (!query || !String(query).trim()) {
    return [];
  }
  const q = `%${String(query).trim()}%`;
  return db
    .prepare(
      `SELECT title FROM pages WHERE title IS NOT NULL AND title LIKE ? ORDER BY LENGTH(title) ASC LIMIT ?`
    )
    .all(q, limit)
    .map((r) => r.title);
}

function seedUrlsIfEmpty(urls, priority = 5) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM crawl_queue').get().c;
  if (count > 0) return;
  const insert = db.prepare('INSERT OR IGNORE INTO crawl_queue (url, priority, depth) VALUES (?, ?, 0)');
  const runMany = db.transaction((list) => {
    for (const u of list) {
      insert.run(u, priority);
    }
  });
  runMany(urls);
}

function reseedQueue(urls, priority = 5) {
  const insert = db.prepare('INSERT OR IGNORE INTO crawl_queue (url, priority, depth) VALUES (?, ?, 0)');
  const runMany = db.transaction((list) => {
    for (const u of list) {
      insert.run(u, priority);
    }
  });
  runMany(urls);
}

function getInboundLinkCount(toUrl) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM links WHERE to_url = ?').get(toUrl);
  return row ? row.c : 0;
}

module.exports = {
  db,
  insertPage,
  insertLink,
  enqueueUrl,
  enqueueUrls,
  getNextInQueue,
  markAttempted,
  removeFromQueue,
  searchPages,
  getStats,
  getTotalIndexedPages,
  suggestTitles,
  seedUrlsIfEmpty,
  reseedQueue,
  getInboundLinkCount,
  selectPageIdByUrl,
  getSetting,
  setSetting,
  upsertQueueUrlsPriority,
};
