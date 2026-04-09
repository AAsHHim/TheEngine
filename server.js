require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { getStats, getTotalIndexedPages, suggestTitles, enqueueUrls } = require('./db/database');
const { initSeeds, seedQueueReseed } = require('./crawler/seeds');
const { scheduler } = require('./crawler/scheduler');
const { crawler } = require('./crawler/crawler');
const { queryEngine } = require('./search/query');
const { getAutoCrawl, setAutoCrawl, getFetchMode } = require('./crawler/crawlSettings');

if (process.env.AUTO_CRAWL === 'true') {
  initSeeds();
  setAutoCrawl(true);
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
    res.json({
      ...stats,
      crawlerRunning: scheduler.isRunning(),
      autoCrawl: getAutoCrawl(),
      fetchMode: getFetchMode(),
    });
  } catch (err) {
    console.error('[TheEngine] /stats error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get('/crawl/config', (req, res) => {
  try {
    res.json({
      autoCrawl: getAutoCrawl(),
      fetchMode: getFetchMode(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/crawl/mode', (req, res) => {
  try {
    const auto = req.body && req.body.auto;
    if (typeof auto !== 'boolean') {
      return res.status(400).json({ error: 'JSON body must include { "auto": true|false }' });
    }
    setAutoCrawl(auto);
    res.json({ ok: true, autoCrawl: getAutoCrawl() });
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
    const enqueued = enqueueUrls(normalized, priority);
    res.json({ ok: true, enqueued, requested: normalized.length });
  } catch (err) {
    console.error('[TheEngine] /crawl/urls error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/crawl/run-batch', (req, res) => {
  setImmediate(() => {
    crawler.crawlBatch(3).catch((err) => console.warn('[TheEngine] run-batch:', err.message));
  });
  res.json({ ok: true, message: 'Processing up to 3 URLs from the queue' });
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
    res.json({
      currentlyCrawling: Boolean(crawler.currentlyCrawling),
      lastCrawledUrl: crawler.lastCrawledUrl || null,
      totalIndexed: getTotalIndexedPages(),
      autoCrawl: getAutoCrawl(),
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
});
