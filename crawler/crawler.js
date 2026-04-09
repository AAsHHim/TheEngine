const crypto = require('crypto');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const {
  insertPage,
  insertLink,
  enqueueUrl,
  getNextInQueue,
  markAttempted,
  removeFromQueue,
  selectPageIdByUrl,
  getStats,
  getSetting,
} = require('../db/database');
const { indexer } = require('./indexer');

const MEDIA_EXT = /\.(pdf|jpe?g|png|gif|webp|mp4|webm|zip|rar|7z|svg|ico|bmp|woff2?|ttf|eot)$/i;
const BLOCKED_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'x.com',
  'www.x.com',
  'facebook.com',
  'www.facebook.com',
  'instagram.com',
  'www.instagram.com',
  'tiktok.com',
  'www.tiktok.com',
]);

const DEFAULT_UA = 'TheEngine-Bot/1.0';

function maxLinkDepthFromSettings() {
  const raw = getSetting('crawl_max_depth', '2');
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(50, n)) : 2;
}

class WebCrawler {
  constructor(db, options = {}) {
    this.db = db;
    this.userAgent = options.userAgent || DEFAULT_UA;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.politenessMs = options.politenessMs ?? 1000;
    /** false = axios + Cheerio only (no Chromium). true = run JS like a real browser. */
    this.usePlaywright =
      options.usePlaywright !== undefined
        ? Boolean(options.usePlaywright)
        : process.env.CRAWL_FETCH_MODE !== 'http';
    this._browser = null;
    this._context = null;
    this._domainLastFetch = new Map();
    this._robotsCache = new Map();
    this.lastCrawledUrl = null;
    this.currentlyCrawling = false;
  }

  get isCrawling() {
    return this.currentlyCrawling;
  }

  async _ensureBrowser() {
    if (!this.usePlaywright) return null;
    if (!this._browser) {
      this._browser = await chromium.launch({ headless: true });
      this._context = await this._browser.newContext({
        userAgent: this.userAgent,
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
      });
    }
    return this._browser;
  }

  async _fetchHtml(normalized) {
    if (this.usePlaywright) {
      await this._ensureBrowser();
      const page = await this._context.newPage();
      try {
        const resp = await page.goto(normalized, {
          waitUntil: 'domcontentloaded',
          timeout: this.timeoutMs,
        });
        const statusCode = resp ? resp.status() : 0;
        const html = await page.content();
        return { statusCode, html };
      } finally {
        await page.close().catch(() => {});
      }
    }
    const res = await axios.get(normalized, {
      timeout: this.timeoutMs,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': this.userAgent,
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
      responseType: 'text',
    });
    const html = typeof res.data === 'string' ? res.data : String(res.data || '');
    return { statusCode: res.status, html };
  }

  normalizeUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return null;
      }
      u.hash = '';
      u.hostname = u.hostname.toLowerCase();
      let path = u.pathname;
      if (path.length > 1 && path.endsWith('/')) {
        path = path.slice(0, -1);
        u.pathname = path;
      }
      return u.href;
    } catch {
      return null;
    }
  }

  _hostAllowed(hostname) {
    const h = hostname.toLowerCase();
    if (BLOCKED_HOSTS.has(h)) return false;
    for (const b of BLOCKED_HOSTS) {
      if (h === b || h.endsWith(`.${b}`)) return false;
    }
    return true;
  }

  _isMediaOrBadExtension(href) {
    try {
      const p = new URL(href).pathname;
      return MEDIA_EXT.test(p);
    } catch {
      return true;
    }
  }

  extractLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const base = new URL(baseUrl);
    const out = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('#')) {
        return;
      }
      let abs;
      try {
        abs = new URL(href, base).href;
      } catch {
        return;
      }
      const norm = this.normalizeUrl(abs);
      if (!norm) return;
      const u = new URL(norm);
      if (!this._hostAllowed(u.hostname)) return;
      if (this._isMediaOrBadExtension(norm)) return;
      out.push(norm);
    });
    return [...new Set(out)];
  }

  extractText(html) {
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe').remove();
    $('nav, footer, header[role="banner"]').remove();
    const text = $('body').text() || $.root().text();
    return String(text)
      .replace(/\s+/g, ' ')
      .trim();
  }

  extractMeta(html) {
    const $ = cheerio.load(html);
    const title = $('title').first().text().trim() || null;
    let description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      null;
    if (description) description = String(description).trim();
    return { title, description };
  }

  _parseRobotsDisallows(text) {
    const disallows = [];
    let inOurSection = false;
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const um = t.match(/^User-agent:\s*(.+)$/i);
      if (um) {
        const ua = um[1].trim().toLowerCase();
        inOurSection = ua === '*' || ua === 'theengine-bot';
        continue;
      }
      const dm = t.match(/^Disallow:\s*(.*)$/i);
      if (dm && inOurSection) {
        const path = dm[1].trim();
        disallows.push(path);
      }
    }
    return disallows;
  }

  _pathDisallowed(pathname, disallows) {
    const path = pathname || '/';
    for (const rule of disallows) {
      if (rule === '') continue;
      if (rule === '/') return true;
      if (path.startsWith(rule)) return true;
    }
    return false;
  }

  async isAllowed(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const origin = `${u.protocol}//${u.host}`;
    if (this._robotsCache.has(origin)) {
      const disallows = this._robotsCache.get(origin);
      if (disallows === null) return false;
      return !this._pathDisallowed(u.pathname, disallows);
    }
    let text = '';
    try {
      const res = await axios.get(`${origin}/robots.txt`, {
        timeout: 10000,
        validateStatus: (s) => s >= 200 && s < 500,
        headers: { 'User-Agent': this.userAgent },
      });
      if (res.status === 404) {
        this._robotsCache.set(origin, []);
        return !this._pathDisallowed(u.pathname, []);
      }
      if (res.status !== 200 || typeof res.data !== 'string') {
        this._robotsCache.set(origin, null);
        return false;
      }
      text = res.data;
    } catch (err) {
      console.warn(`[TheEngine] robots.txt fetch failed for ${origin}:`, err.message);
      this._robotsCache.set(origin, null);
      return false;
    }
    const disallows = this._parseRobotsDisallows(text);
    this._robotsCache.set(origin, disallows);
    return !this._pathDisallowed(u.pathname, disallows);
  }

  async _politenessWait(hostname) {
    const h = hostname.toLowerCase();
    const now = Date.now();
    const last = this._domainLastFetch.get(h) || 0;
    const wait = this.politenessMs - (now - last);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    this._domainLastFetch.set(h, Date.now());
  }

  /**
   * @param {string} url
   * @param {number} [pageDepth] BFS depth for this URL (seeds are 0). Discovered links are enqueued at pageDepth+1 while pageDepth+1 <= crawl_max_depth setting.
   */
  async crawlUrl(url, pageDepth = 0) {
    const normalized = this.normalizeUrl(url);
    if (!normalized) {
      console.warn(`[TheEngine] Skip invalid URL: ${url}`);
      return null;
    }

    const maxD = maxLinkDepthFromSettings();

    try {
      const allowed = await this.isAllowed(normalized);
      if (!allowed) {
        console.warn(`[TheEngine] robots.txt disallowed: ${normalized}`);
        return null;
      }

      const hostname = new URL(normalized).hostname;
      await this._politenessWait(hostname);

      let statusCode = 0;
      let html = '';
      try {
        const fetched = await this._fetchHtml(normalized);
        statusCode = fetched.statusCode;
        html = fetched.html;
      } catch (err) {
        console.warn(`[TheEngine] crawl failed ${normalized}:`, err.message);
        return null;
      }

      const meta = this.extractMeta(html);
      const bodyText = this.extractText(html);
      const links = this.extractLinks(html, normalized);
      const contentHash = crypto.createHash('md5').update(bodyText).digest('hex');

      const existing = selectPageIdByUrl.get(normalized);
      if (existing && existing.content_hash === contentHash) {
        for (const to of links) {
          insertLink(normalized, to);
          if (pageDepth + 1 <= maxD) {
            enqueueUrl(to, 5, pageDepth + 1);
          }
        }
        this.lastCrawledUrl = normalized;
        return normalized;
      }

      const pageId = insertPage(
        normalized,
        meta.title,
        meta.description,
        bodyText,
        statusCode,
        contentHash
      );

      for (const to of links) {
        insertLink(normalized, to);
        if (pageDepth + 1 <= maxD) {
          enqueueUrl(to, 5, pageDepth + 1);
        }
      }

      indexer.indexPage(pageId, bodyText);

      this.lastCrawledUrl = normalized;
      const stats = getStats();
      console.log(`[TheEngine] Crawled: ${normalized} | Pages indexed: ${stats.pageCount}`);
      return normalized;
    } catch (err) {
      console.warn(`[TheEngine] crawlUrl error ${url}:`, err.message);
      return null;
    }
  }

  /**
   * @param {number} n
   * @param {{ parallel?: boolean, shouldContinue?: () => boolean }} [options]
   *   parallel (default true): dequeue all n then fetch in parallel (fast manual batches).
   *   parallel false + shouldContinue: dequeue one URL at a time; stop between URLs when shouldContinue is false (auto loop obeys manual mode).
   */
  async crawlBatch(n = 5, options = {}) {
    const parallel = options.parallel !== false;
    const shouldContinueFn = typeof options.shouldContinue === 'function' ? options.shouldContinue : null;

    if (parallel && !shouldContinueFn) {
      const jobs = [];
      for (let i = 0; i < n; i++) {
        const row = getNextInQueue();
        if (!row) break;
        markAttempted(row.url);
        removeFromQueue(row.url);
        jobs.push({ url: row.url, depth: row.depth ?? 0 });
      }
      if (jobs.length === 0) return [];

      this.currentlyCrawling = true;
      const results = [];
      try {
        const out = await Promise.all(
          jobs.map(({ url: u, depth: d }) =>
            this.crawlUrl(u, d).catch((err) => {
              console.warn(`[TheEngine] crawlUrl rejected ${u}:`, err.message);
              return null;
            })
          )
        );
        for (const u of out) {
          if (u) results.push({ url: u });
        }
        return results;
      } finally {
        this.currentlyCrawling = false;
      }
    }

    this.currentlyCrawling = true;
    const results = [];
    try {
      for (let i = 0; i < n; i++) {
        if (shouldContinueFn && !shouldContinueFn()) break;
        const row = getNextInQueue();
        if (!row) break;
        markAttempted(row.url);
        removeFromQueue(row.url);
        const u = await this.crawlUrl(row.url, row.depth ?? 0).catch((err) => {
          console.warn(`[TheEngine] crawlUrl rejected ${row.url}:`, err.message);
          return null;
        });
        if (u) results.push({ url: u });
      }
    } finally {
      this.currentlyCrawling = false;
    }
    return results;
  }

  async close() {
    if (this._context) {
      await this._context.close().catch(() => {});
      this._context = null;
    }
    if (this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
    }
  }
}

const { db } = require('../db/database');
const usePlaywright = process.env.CRAWL_FETCH_MODE !== 'http';
const crawler = new WebCrawler(db, { usePlaywright });

module.exports = {
  WebCrawler,
  crawler,
};
