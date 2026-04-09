require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const {
  getStats,
  getTotalIndexedPages,
  suggestTitles,
  enqueueUrls,
  getSetting,
  setSetting,
  upsertQueueUrlsPriority,
} = require('./db/database');
const { initSeeds, seedQueueReseed } = require('./crawler/seeds');
const { scheduler } = require('./crawler/scheduler');
const { crawler } = require('./crawler/crawler');
const { queryEngine } = require('./search/query');
const { getFetchMode } = require('./crawler/crawlSettings');

if (process.env.AUTO_CRAWL === 'true') {
  initSeeds();
}

const app = express();
app.use(cors());
app.use(express.json());

function normalizeUserUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const results = await queryEngine.search(q, limit);
    res.json(results);
  } catch (err) {
    console.error('[TheEngine] /search error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/suggest', (req, res) => {
  try {
    const q = req.query.q || '';
    const titles = suggestTitles(q, 5);
    res.json(titles);
  } catch (err) {
    console.error('[TheEngine] /suggest error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/stats', (req, res) => {
  try {
    const stats = getStats();
    const mode = getSetting('crawl_mode', 'manual');
    const autoCrawl = mode === 'auto';
    res.json({
      ...stats,
      schedulerActive: scheduler.isRunning(),
      crawlerRunning: scheduler.isRunning(),
      autoCrawl,
      crawlMode: mode,
      fetchMode: getFetchMode(),
    });
  } catch (err) {
    console.error('[TheEngine] /stats error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/crawl/config', (req, res) => {
  try {
    const mode = getSetting('crawl_mode', 'manual');
    res.json({
      autoCrawl: mode === 'auto',
      crawlMode: mode,
      fetchMode: getFetchMode(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/crawl/mode', (req, res) => {
  try {
    const mode = getSetting('crawl_mode', 'manual');
    res.json({
      mode,
      running: scheduler.isRunning(),
    });
  } catch (err) {
    console.error('[TheEngine] /crawl/mode error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/crawl/mode', (req, res) => {
  try {
    const mode = req.body && req.body.mode;
    if (mode !== 'auto' && mode !== 'manual') {
      return res.status(400).json({ error: 'JSON body must include { "mode": "auto" | "manual" }' });
    }
    if (mode === 'auto') {
      scheduler.start();
    } else {
      scheduler.stop();
    }
    const next = getSetting('crawl_mode', 'manual');
    res.json({ success: true, mode: next });
  } catch (err) {
    console.error('[TheEngine] /crawl/mode error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/crawl/urls', (req, res) => {
  try {
    const raw = req.body && Array.isArray(req.body.urls) ? req.body.urls : [];
    const priority = Math.min(100, Math.max(1, Number(req.body && req.body.priority) || 5));
    const normalized = [];
    for (const line of raw) {
      const n = normalizeUserUrl(line);
      if (n) normalized.push(n);
    }
    const enqueued = enqueueUrls(normalized, priority, 0);
    res.json({ ok: true, enqueued, requested: normalized.length });
  } catch (err) {
    console.error('[TheEngine] /crawl/urls error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** Enqueue URLs at highest priority (above the rest of the queue), set max link depth, run one batch immediately. */
app.post('/crawl/target', async (req, res) => {
  try {
    const raw = req.body && Array.isArray(req.body.urls) ? req.body.urls : [];
    const batchSize = Math.min(50, Math.max(1, parseInt(String(req.body && req.body.batchSize), 10) || 3));
    const rawDepth = req.body && req.body.maxDepth;
    let maxDepth =
      rawDepth === undefined || rawDepth === ''
        ? parseInt(String(getSetting('crawl_max_depth', '2')), 10)
        : parseInt(String(rawDepth), 10);
    if (!Number.isFinite(maxDepth)) {
      return res.status(400).json({ error: 'maxDepth must be a number (link hops from your URLs)' });
    }
    maxDepth = Math.min(50, Math.max(0, maxDepth));

    const normalized = [];
    for (const line of raw) {
      const n = normalizeUserUrl(line);
      if (n) normalized.push(n);
    }
    if (normalized.length === 0) {
      return res.status(400).json({ error: 'Provide at least one valid URL in urls[]' });
    }

    setSetting('crawl_max_depth', String(maxDepth));
    upsertQueueUrlsPriority(normalized, 1000, 0);

    const out = await scheduler.crawlOnce(batchSize);
    if (out && out.skipped) {
      return res.json({
        success: true,
        skipped: true,
        reason: out.reason,
        maxDepth,
        enqueued: normalized.length,
      });
    }
    res.json({
      success: true,
      maxDepth,
      enqueued: normalized.length,
      crawled: out.crawled,
      urls: out.urls,
    });
  } catch (err) {
    console.error('[TheEngine] /crawl/target error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/crawl/run-batch', async (req, res) => {
  try {
    const out = await scheduler.crawlOnce(3);
    if (out && out.skipped) {
      return res.json({ ok: true, skipped: true, reason: out.reason });
    }
    res.json({
      ok: true,
      message: 'Processed up to 3 URLs from the queue',
      crawled: out.crawled,
      urls: out.urls,
    });
  } catch (err) {
    console.error('[TheEngine] /crawl/run-batch error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/crawl/now', async (req, res) => {
  try {
    const raw = req.body && req.body.batchSize;
    const batchSize = Math.min(50, Math.max(1, parseInt(String(raw), 10) || 3));
    const out = await scheduler.crawlOnce(batchSize);
    if (out && out.skipped) {
      return res.json({ skipped: true, reason: out.reason });
    }
    res.json({ crawled: out.crawled, urls: out.urls });
  } catch (err) {
    console.error('[TheEngine] /crawl/now error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/crawl/seed', (req, res) => {
  try {
    seedQueueReseed();
    res.json({ ok: true, message: 'Seed URLs enqueued' });
  } catch (err) {
    console.error('[TheEngine] /crawl/seed error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/crawl/status', (req, res) => {
  try {
    const s = scheduler.getStatus();
    const stats = getStats();
    res.json({
      ...s,
      pageCount: stats.pageCount,
      linkCount: stats.linkCount,
      queueSize: stats.queueSize,
      currentlyCrawling: Boolean(crawler.currentlyCrawling),
      lastCrawledUrl: crawler.lastCrawledUrl || s.lastCrawledUrl || null,
      totalIndexed: getTotalIndexedPages(),
      fetchMode: getFetchMode(),
    });
  } catch (err) {
    console.error('[TheEngine] /crawl/status error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[TheEngine] 🔍 Running at http://localhost:${port}`);
  scheduler.init();
});
