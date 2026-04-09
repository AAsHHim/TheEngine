/** Undici (pulled in by axios 1.15+) expects global File; Node 18 exposes it from buffer only. */
if (typeof globalThis.File === 'undefined') {
  globalThis.File = require('node:buffer').File;
}

require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');

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
const { ProxyEngine, AXIOS_HEADERS } = require('./proxy/proxy');

const proxyEngine = new ProxyEngine();

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

if (process.env.AUTO_CRAWL === 'true') {
  initSeeds();
}

const app = express();
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

function getBaseProxyUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

/** Hop-by-hop and values we replace server-side (cookie jar, safe encoding). */
const SKIP_FORWARD_HEADER = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'cookie',
]);

/**
 * Forward almost all browser headers so sites like Discord keep X-Super-Properties,
 * X-Discord-Locale, sec-fetch-*, authorization, etc. Strip Cookie (use server jar).
 */
function forwardBrowserHeaders(req) {
  const out = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (SKIP_FORWARD_HEADER.has(key.toLowerCase())) continue;
    if (val === undefined) continue;
    out[key] = Array.isArray(val) ? val.join(', ') : val;
  }
  return out;
}

/** HTML/CSS/asset fetches through GET /proxy — browser defaults + client hints. */
function mergeUpstreamHeadersForPage(req) {
  return {
    ...AXIOS_HEADERS,
    ...forwardBrowserHeaders(req),
    'accept-encoding': AXIOS_HEADERS['accept-encoding'],
  };
}

/** JSON/API through /proxy/api — same, plus target Origin/Referer; drop Upgrade header. */
function mergeUpstreamHeadersForApi(req, targetUrl) {
  const t = new URL(targetUrl);
  const origin = `${t.protocol}//${t.host}`;
  const merged = {
    ...AXIOS_HEADERS,
    ...forwardBrowserHeaders(req),
    origin,
    referer: `${t.origin}/`,
    'accept-encoding': AXIOS_HEADERS['accept-encoding'],
  };
  delete merged['upgrade-insecure-requests'];
  return merged;
}

function buildPostBody(req) {
  const ct = req.get('content-type') || '';
  if (ct.includes('application/json') && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return { data: JSON.stringify(req.body), contentType: 'application/json; charset=utf-8' };
  }
  if (typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.body)) {
      if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
      else params.append(k, String(v));
    }
    return { data: params.toString(), contentType: 'application/x-www-form-urlencoded; charset=utf-8' };
  }
  if (typeof req.body === 'string') {
    return { data: req.body, contentType: ct || 'text/plain; charset=utf-8' };
  }
  if (Buffer.isBuffer(req.body)) {
    return { data: req.body, contentType: ct || 'application/octet-stream' };
  }
  return { data: req.body, contentType: ct || 'application/octet-stream' };
}

function isBinaryAssetPath(urlStr) {
  try {
    const pathname = new URL(urlStr).pathname;
    return /\.(png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|mp4|mp3|pdf)$/i.test(pathname);
  } catch {
    return false;
  }
}

function isCssPath(urlStr) {
  try {
    return /\.css$/i.test(new URL(urlStr).pathname);
  } catch {
    return false;
  }
}

function isHtmlCt(ct) {
  return /text\/html/i.test(ct || '');
}

function isCssCt(ct) {
  return /text\/css/i.test(ct || '');
}

function isJsonCt(ct) {
  const c = String(ct || '').toLowerCase();
  return c.includes('json') || c.includes('application/ld+json');
}

async function sendFetchedBufferAsProxy(req, res, r, rawParam) {
  const ct = r.contentType || '';
  const finalUrl = r.finalUrl || rawParam;
  const base = getBaseProxyUrl(req);

  if (isHtmlCt(ct)) {
    const html = proxyEngine.bytesToText(r.buffer, ct);
    const out = proxyEngine.rewriteHtml(html, finalUrl, base);
    res.setHeader('X-Powered-By', 'TheEngine-Proxy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(out);
  }
  if (isCssCt(ct)) {
    const css = proxyEngine.bytesToText(r.buffer, ct);
    const out = proxyEngine.rewriteCss(css, finalUrl, base);
    res.setHeader('X-Powered-By', 'TheEngine-Proxy');
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    return res.send(out);
  }
  if (isJsonCt(ct)) {
    res.setHeader('X-Powered-By', 'TheEngine-Proxy');
    res.setHeader('Content-Type', ct.split(';')[0] || 'application/json');
    return res.send(r.buffer);
  }
  res.setHeader('X-Powered-By', 'TheEngine-Proxy');
  res.setHeader('Content-Type', ct || 'application/octet-stream');
  return res.send(r.buffer);
}

async function handleProxyGet(req, res, opts = {}) {
  const forceRaw = Boolean(opts.forceRaw);
  try {
    const rawParam = proxyEngine.decodeProxyUrl(req.query.url);
    if (!rawParam || !/^https?:\/\//i.test(rawParam)) {
      return res.status(400).type('text/plain').send('Invalid url');
    }

    const wantRaw = forceRaw || req.query.raw === '1';
    const fwd = mergeUpstreamHeadersForPage(req);

    if (wantRaw || isBinaryAssetPath(rawParam)) {
      return proxyEngine.pipeRawResponse(rawParam, res, { headers: fwd });
    }

    if (isCssPath(rawParam)) {
      const tr = await proxyEngine.fetchTextResource(rawParam, { headers: fwd });
      if (!tr.ok) {
        res.setHeader('X-Powered-By', 'TheEngine-Proxy');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res
          .status(502)
          .send(proxyEngine.buildErrorPageHtml(rawParam, tr.error || 'fetch failed'));
      }
      const rewritten = proxyEngine.rewriteCss(tr.text, tr.finalUrl || rawParam, getBaseProxyUrl(req));
      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      return res.send(rewritten);
    }

    const r = await proxyEngine.fetchUpstreamBuffer(rawParam, { headers: fwd });
    if (r.blocked) {
      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(403).send(proxyEngine.blockedPageHtml(rawParam));
    }
    if (!r.ok) {
      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(502).send(proxyEngine.buildErrorPageHtml(rawParam, r.error || 'fetch failed'));
    }

    return sendFetchedBufferAsProxy(req, res, r, rawParam);
  } catch (err) {
    const fallbackUrl = proxyEngine.decodeProxyUrl(req.query.url) || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Powered-By', 'TheEngine-Proxy');
    return res
      .status(502)
      .send(proxyEngine.buildErrorPageHtml(fallbackUrl, String(err.message || err)));
  }
}

async function handleProxyPost(req, res) {
  try {
    const rawParam = proxyEngine.decodeProxyUrl(req.query.url);
    if (!rawParam || !/^https?:\/\//i.test(rawParam)) {
      return res.status(400).type('text/plain').send('Invalid url');
    }

    const { data, contentType } = buildPostBody(req);
    const fwd = mergeUpstreamHeadersForPage(req);
    fwd['content-type'] = contentType;

    const result = await proxyEngine.singleHopFetch(rawParam, {
      method: 'POST',
      body: data,
      headers: fwd,
    });

    if (result.blocked) {
      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(403).send(proxyEngine.blockedPageHtml(rawParam));
    }
    if (result.error) {
      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res
        .status(502)
        .send(proxyEngine.buildErrorPageHtml(rawParam, String(result.error.message || result.error)));
    }

    if (REDIRECT_STATUSES.has(result.statusCode) && result.headers.location) {
      const abs = new URL(result.headers.location, rawParam).href;
      return res.redirect(302, `${getBaseProxyUrl(req)}/proxy?url=${encodeURIComponent(abs)}`);
    }

    if (result.statusCode >= 400 || result.data == null) {
      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res
        .status(502)
        .send(proxyEngine.buildErrorPageHtml(rawParam, `HTTP ${result.statusCode}`));
    }

    const ct = result.headers['content-type'] || '';
    const finalUrl = result.finalUrl || rawParam;
    const buffer = Buffer.from(result.data);
    return sendFetchedBufferAsProxy(req, res, { buffer, contentType: ct, finalUrl }, rawParam);
  } catch (err) {
    const fallbackUrl = proxyEngine.decodeProxyUrl(req.query.url) || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Powered-By', 'TheEngine-Proxy');
    return res
      .status(502)
      .send(proxyEngine.buildErrorPageHtml(fallbackUrl, String(err.message || err)));
  }
}

function filterApiResponseHeaders(res, upstreamHeaders) {
  for (const [key, val] of Object.entries(upstreamHeaders)) {
    const lk = key.toLowerCase();
    if (lk === 'access-control-allow-origin') continue;
    if (lk === 'content-security-policy') continue;
    if (lk === 'x-frame-options') continue;
    if (lk === 'set-cookie') continue;
    if (lk === 'content-length') continue;
    if (lk === 'transfer-encoding') continue;
    if (val !== undefined) res.setHeader(key, val);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Powered-By', 'TheEngine-Proxy');
}

async function handleProxyApi(req, res) {
  try {
    const rawParam = proxyEngine.decodeProxyUrl(req.query.url);
    if (!rawParam || !/^https?:\/\//i.test(rawParam)) {
      return res.status(400).type('text/plain').send('Invalid url');
    }
    if (proxyEngine.isBlockedDomain(rawParam)) {
      return res.status(403).type('text/plain').send('blocked');
    }

    const fwd = mergeUpstreamHeadersForApi(req, rawParam);

    let bodyData;
    if (req.method === 'POST') {
      const built = buildPostBody(req);
      bodyData = built.data;
      fwd['content-type'] = built.contentType;
    }

    const out = await proxyEngine.proxyApiRequest(rawParam, {
      method: req.method,
      data: bodyData,
      headers: fwd,
    });

    if (out.blocked) {
      return res.status(403).type('text/plain').send('blocked');
    }
    if (out.error) {
      return res.status(502).type('text/plain').send(String(out.error.message || out.error));
    }

    const axiosRes = out.response;
    filterApiResponseHeaders(res, axiosRes.headers);
    return res.status(axiosRes.status).send(Buffer.from(axiosRes.data));
  } catch (err) {
    return res.status(502).type('text/plain').send(String(err.message || err));
  }
}

function handleProxyApiOptions(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  const reqHdr = req.get('Access-Control-Request-Headers');
  res.setHeader('Access-Control-Allow-Headers', reqHdr || '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.sendStatus(204);
}

function handleProxyError(res, req, err) {
  if (res.headersSent) return;
  const fallbackUrl = proxyEngine.decodeProxyUrl(req.query.url) || '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Powered-By', 'TheEngine-Proxy');
  res
    .status(502)
    .send(proxyEngine.buildErrorPageHtml(fallbackUrl, String(err.message || err)));
}

/** Proxy routes before other middleware so they are never shadowed. */
app.use((req, res, next) => {
  const p = req.path;
  if (p === '/proxy' || p === '/proxy/') {
    if (req.method === 'GET') {
      return handleProxyGet(req, res, {}).catch((err) => handleProxyError(res, req, err));
    }
    if (req.method === 'POST') {
      return handleProxyPost(req, res).catch((err) => handleProxyError(res, req, err));
    }
    return next();
  }
  if (p === '/proxy/raw' || p === '/proxy/raw/') {
    if (req.method === 'GET') {
      return handleProxyGet(req, res, { forceRaw: true }).catch((err) => handleProxyError(res, req, err));
    }
    return next();
  }
  if (p === '/proxy/api' || p === '/proxy/api/') {
    if (req.method === 'OPTIONS') {
      return handleProxyApiOptions(req, res);
    }
    if (req.method === 'GET' || req.method === 'POST') {
      return handleProxyApi(req, res).catch((err) => {
        if (!res.headersSent) res.status(502).send(String(err.message || err));
      });
    }
    return next();
  }
  next();
});

app.use(cors());

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

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    const pathname = u.pathname;
    const prefix = '/proxy/ws/';
    if (!pathname.startsWith(prefix)) {
      socket.destroy();
      return;
    }
    const encoded = pathname.slice(prefix.length);
    if (!encoded) {
      socket.destroy();
      return;
    }
    let targetWsUrl;
    try {
      targetWsUrl = decodeURIComponent(encoded);
    } catch {
      socket.destroy();
      return;
    }
    if (!/^wss?:\/\//i.test(targetWsUrl)) {
      socket.destroy();
      return;
    }

    const wss = new WebSocket.Server({ noServer: true });
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const protoHeader = req.headers['sec-websocket-protocol'];
      const protocols = protoHeader
        ? protoHeader.split(',').map((p) => p.trim()).filter(Boolean)
        : [];

      let targetOrigin;
      try {
        targetOrigin = new URL(targetWsUrl).origin;
      } catch {
        targetOrigin = undefined;
      }

      const upstream = new WebSocket(targetWsUrl, protocols.length ? protocols : undefined, {
        headers: targetOrigin ? { Origin: targetOrigin } : {},
      });

      const pending = [];
      const flushPending = () => {
        while (pending.length && upstream.readyState === WebSocket.OPEN) {
          const [data, isBinary] = pending.shift();
          upstream.send(data, { binary: Boolean(isBinary) });
        }
      };

      clientWs.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: Boolean(isBinary) });
        } else {
          pending.push([data, isBinary]);
        }
      });

      upstream.on('open', () => {
        flushPending();
      });

      upstream.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: Boolean(isBinary) });
        }
      });

      clientWs.on('close', (code, reason) => {
        try {
          upstream.close(code, reason);
        } catch {
          try {
            upstream.close();
          } catch {
            /* ignore */
          }
        }
      });

      upstream.on('close', (code, reason) => {
        try {
          clientWs.close(code, reason);
        } catch {
          try {
            clientWs.close();
          } catch {
            /* ignore */
          }
        }
      });

      clientWs.on('error', () => {
        try {
          upstream.close();
        } catch {
          /* ignore */
        }
      });

      upstream.on('error', () => {
        try {
          clientWs.close();
        } catch {
          /* ignore */
        }
      });
    });
  } catch {
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
});

server.listen(port, () => {
  console.log(`[TheEngine] 🔍 Running at http://localhost:${port}`);
  console.log(
    `[TheEngine] Proxy: GET/POST /proxy, GET /proxy/raw, GET/POST /proxy/api, WS /proxy/ws/*`
  );
  scheduler.init();
});
