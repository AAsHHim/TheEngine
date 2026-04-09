const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const AXIOS_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  DNT: '1',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

function parseCharsetFromContentType(contentType) {
  if (!contentType || typeof contentType !== 'string') return 'utf-8';
  const m = contentType.match(/charset\s*=\s*["']?([^"';\s]+)/i);
  if (!m) return 'utf-8';
  let c = m[1].trim().toLowerCase();
  if (c === 'utf8') c = 'utf-8';
  return c;
}

function normalizeEncodingForIconv(charset) {
  const c = String(charset || 'utf-8').toLowerCase();
  const map = {
    'iso-8859-1': 'latin1',
    iso8859_1: 'latin1',
    'windows-1252': 'win1252',
    cp1252: 'win1252',
  };
  return map[c] || c;
}

function bufferToString(buffer, contentType) {
  const charset = parseCharsetFromContentType(contentType);
  const enc = normalizeEncodingForIconv(charset);
  try {
    return iconv.decode(Buffer.from(buffer), enc);
  } catch {
    return Buffer.from(buffer).toString('utf8');
  }
}

class ProxyEngine {
  constructor() {
    this.cache = new Map();
    this.cacheMaxSize = 50;
    this.blockedDomains = [
      'google-analytics.com',
      'doubleclick.net',
      'googlesyndication.com',
      'adservice.google.com',
      'facebook.com',
      'connect.facebook.net',
    ];
  }

  buildCacheKey(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href;
    } catch {
      return String(url);
    }
  }

  pruneCache() {
    while (this.cache.size > this.cacheMaxSize) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
  }

  touchCache(key) {
    if (!this.cache.has(key)) return;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
  }

  isBlockedDomain(url) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return true;
    }
    for (const d of this.blockedDomains) {
      if (host === d || host.endsWith(`.${d}`)) return true;
    }
    return false;
  }

  blockedPageHtml(targetUrl) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>TheEngine — Blocked</title>
  <style>
    body { background: #0a0a0a; color: #e8e8e8; font-family: 'JetBrains Mono', monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { border: 1px solid #ff8800; padding: 40px; max-width: 500px; }
    h1 { color: #ff8800; font-size: 14px; letter-spacing: 3px; margin: 0 0 16px; }
    p { color: #888; font-size: 12px; line-height: 1.6; }
    a { color: #00ff88; }
    code { background: #1a1a1a; padding: 2px 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>// PROXY BLOCKED</h1>
    <p>This host is not proxied: <code>${this._esc(targetUrl)}</code></p>
    <p><a href="/">← Back to TheEngine</a></p>
  </div>
</body>
</html>`;
  }

  buildErrorPageHtml(targetUrl, errorMessage) {
    return `<!DOCTYPE html>
<html>
<head>
  <title>TheEngine — Proxy Error</title>
  <style>
    body { background: #0a0a0a; color: #e8e8e8; font-family: 'JetBrains Mono', monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { border: 1px solid #ff4444; padding: 40px; max-width: 500px; }
    h1 { color: #ff4444; font-size: 14px; letter-spacing: 3px; margin: 0 0 16px; }
    p { color: #888; font-size: 12px; line-height: 1.6; }
    a { color: #00ff88; }
    code { background: #1a1a1a; padding: 2px 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>// PROXY ERROR</h1>
    <p>Could not fetch: <code>${this._esc(targetUrl)}</code></p>
    <p>${this._esc(String(errorMessage || 'Unknown error'))}</p>
    <p><a href="/">← Back to TheEngine</a></p>
  </div>
</body>
</html>`;
  }

  _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  encodeProxyUrl(url) {
    return encodeURIComponent(url);
  }

  decodeProxyUrl(encoded) {
    if (encoded == null || encoded === '') return null;
    try {
      return decodeURIComponent(String(encoded));
    } catch {
      return null;
    }
  }

  resolveUrl(href, base) {
    if (href == null || href === '') return null;
    const s = String(href).trim();
    if (s.startsWith('data:') || s.startsWith('javascript:') || s.startsWith('mailto:') || s.startsWith('tel:') || s === '#') {
      return null;
    }
    try {
      return new URL(s, base).href;
    } catch {
      return null;
    }
  }

  proxyLink(baseProxyUrl, absoluteUrl) {
    if (!absoluteUrl) return null;
    return `${baseProxyUrl}/proxy?url=${this.encodeProxyUrl(absoluteUrl)}`;
  }

  injectProxyBar(html, targetUrl) {
    const bar = `<div id="__theengine_bar__" style="
  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
  background: #0a0a0a; border-bottom: 2px solid #00ff88;
  font-family: 'JetBrains Mono', monospace; font-size: 12px;
  color: #e8e8e8; padding: 6px 12px;
  display: flex; align-items: center; gap: 12px;
">
  <a href="/" style="color:#00ff88; text-decoration:none; font-weight:bold; letter-spacing:2px;">⬡ TheEngine</a>
  <span style="color:#444">|</span>
  <span style="color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${this._esc(targetUrl)}</span>
  <a href="${this._esc(targetUrl)}" target="_blank" style="color:#555; font-size:11px; text-decoration:none; white-space:nowrap;">↗ open real</a>
  <a href="javascript:history.back()" style="color:#555; font-size:11px; text-decoration:none;">← back</a>
  <a href="/" style="color:#555; font-size:11px; text-decoration:none;">🔍 search</a>
</div>
<div style="height: 34px;"></div>
<style>
  #__theengine_bar__ * { box-sizing: border-box; }
  body { margin-top: 0 !important; }
</style>`;
    const $ = cheerio.load(html);
    if ($('body').length) {
      $('body').prepend(bar);
    } else {
      $.root().append(`<body>${bar}</body>`);
    }
    return $.html();
  }

  stripScriptRedirects(scriptText) {
    if (!scriptText) return scriptText;
    return scriptText
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (/window\.location/i.test(t)) return false;
        if (/document\.location/i.test(t)) return false;
        if (/location\.href\s*=/i.test(t)) return false;
        return true;
      })
      .join('\n');
  }

  rewriteMetaRefresh($, targetUrl, baseProxyUrl) {
    $('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]').each((_, el) => {
      const $el = $(el);
      const content = $el.attr('content');
      if (!content) return;
      const m = content.match(/url\s*=\s*(.+)/i);
      if (!m) return;
      const raw = m[1].trim().replace(/^["']|["']$/g, '');
      const abs = this.resolveUrl(raw, targetUrl);
      if (!abs) return;
      const pl = this.proxyLink(baseProxyUrl, abs);
      if (!pl) return;
      const quoted = JSON.stringify(pl);
      const newContent = content.replace(/url\s*=\s*.+/i, `url=${quoted}`);
      $el.attr('content', newContent);
    });
  }

  rewriteHtml(html, targetUrl, baseProxyUrl) {
    const $ = cheerio.load(html);
    const base = targetUrl;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const abs = this.resolveUrl(href, base);
      if (!abs) return;
      const pl = this.proxyLink(baseProxyUrl, abs);
      if (pl) $(el).attr('href', pl);
    });

    $('form[action]').each((_, el) => {
      const act = $(el).attr('action');
      const abs =
        act === undefined || act === ''
          ? this.resolveUrl('', base)
          : this.resolveUrl(act, base);
      if (!abs) return;
      const pl = this.proxyLink(baseProxyUrl, abs);
      if (pl) $(el).attr('action', pl);
    });

    $('form:not([action])').each((_, el) => {
      const pl = this.proxyLink(baseProxyUrl, base);
      if (pl) $(el).attr('action', pl);
    });

    $('frame[src], iframe[src]').each((_, el) => {
      const src = $(el).attr('src');
      const abs = this.resolveUrl(src, base);
      if (!abs) return;
      const pl = this.proxyLink(baseProxyUrl, abs);
      if (pl) $(el).attr('src', pl);
    });

    this.rewriteMetaRefresh($, base, baseProxyUrl);

    const assetAttrs = [
      ['img', 'src'],
      ['link', 'href'],
      ['script', 'src'],
      ['video', 'src'],
      ['audio', 'src'],
      ['source', 'src'],
    ];
    for (const [tag, attr] of assetAttrs) {
      $(`${tag}[${attr}]`).each((_, el) => {
        const v = $(el).attr(attr);
        const abs = this.resolveUrl(v, base);
        if (abs) $(el).attr(attr, abs);
      });
    }

    $('source[srcset]').each((_, el) => {
      const v = $(el).attr('srcset');
      if (!v) return;
      const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
      const out = parts.map((part) => {
        const bits = part.split(/\s+/);
        const urlPart = bits[0];
        const rest = bits.slice(1).join(' ');
        const abs = this.resolveUrl(urlPart, base);
        if (!abs) return part;
        return rest ? `${abs} ${rest}` : abs;
      });
      $(el).attr('srcset', out.join(', '));
    });

    $('meta[name="referrer"], meta[name="Referrer"]').remove();
    $('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="content-security-policy"]').remove();

    $('script').each((_, el) => {
      const $el = $(el);
      if ($el.attr('src')) return;
      const txt = $el.html();
      const next = this.stripScriptRedirects(txt);
      $el.html(next);
    });

    let out = $.html();
    out = this.injectProxyBar(out, targetUrl);
    return out;
  }

  rewriteCss(css, targetUrl, baseProxyUrl) {
    const base = targetUrl;
    return css.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (full, _q, inner) => {
      const raw = String(inner).trim();
      if (raw.startsWith('data:') || raw.startsWith('#')) return full;
      const abs = this.resolveUrl(raw, base);
      if (!abs) return full;
      return `url("${abs}")`;
    });
  }

  async fetchPage(targetUrl) {
    const key = this.buildCacheKey(targetUrl);
    if (this.cache.has(key)) {
      this.touchCache(key);
      return this.cache.get(key);
    }

    if (this.isBlockedDomain(targetUrl)) {
      const html = this.blockedPageHtml(targetUrl);
      return { html, finalUrl: targetUrl, isError: false, blocked: true };
    }

    try {
      const res = await axios.get(targetUrl, {
        headers: AXIOS_HEADERS,
        timeout: 15000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });

      const finalUrl =
        (res.request && res.request.res && res.request.res.responseUrl) ||
        res.config.url ||
        targetUrl;
      const ct = res.headers['content-type'] || '';
      if (res.status >= 400) {
        return {
          html: this.buildErrorPageHtml(targetUrl, `HTTP ${res.status}`),
          finalUrl: targetUrl,
          isError: true,
        };
      }

      const html = bufferToString(res.data, ct);
      const payload = { html, finalUrl, isError: false };
      this.cache.set(key, payload);
      this.touchCache(key);
      this.pruneCache();
      return payload;
    } catch (err) {
      const msg = err.response
        ? `HTTP ${err.response.status}`
        : err.code || err.message || String(err);
      return {
        html: this.buildErrorPageHtml(targetUrl, msg),
        finalUrl: targetUrl,
        isError: true,
      };
    }
  }

  /**
   * Fetch arbitrary URL as decoded string (for CSS). No HTML cache.
   */
  async fetchTextResource(targetUrl) {
    if (this.isBlockedDomain(targetUrl)) {
      return { ok: false, error: 'blocked' };
    }
    try {
      const res = await axios.get(targetUrl, {
        headers: AXIOS_HEADERS,
        timeout: 15000,
        maxRedirects: 5,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      });
      const ct = res.headers['content-type'] || '';
      if (res.status >= 400) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const text = bufferToString(res.data, ct);
      return { ok: true, text, contentType: ct };
    } catch (err) {
      const msg = err.response
        ? `HTTP ${err.response.status}`
        : err.code || err.message || String(err);
      return { ok: false, error: msg };
    }
  }

  /**
   * Stream upstream bytes to Express response (images, fonts, raw passthrough).
   */
  async pipeRawResponse(targetUrl, res) {
    if (this.isBlockedDomain(targetUrl)) {
      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(403).send(this.blockedPageHtml(targetUrl));
    }
    try {
      const upstream = await axios.get(targetUrl, {
        headers: AXIOS_HEADERS,
        timeout: 15000,
        maxRedirects: 5,
        responseType: 'stream',
        validateStatus: () => true,
      });

      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      if (upstream.status >= 400) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res
          .status(502)
          .send(this.buildErrorPageHtml(targetUrl, `HTTP ${upstream.status}`));
      }

      const ct = upstream.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      upstream.data.on('error', (err) => {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.status(502).send(this.buildErrorPageHtml(targetUrl, err.message || 'stream error'));
        } else {
          res.destroy(err);
        }
      });
      upstream.data.pipe(res);
    } catch (err) {
      const msg = err.response
        ? `HTTP ${err.response.status}`
        : err.code || err.message || String(err);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Powered-By', 'TheEngine-Proxy');
        res.status(502).send(this.buildErrorPageHtml(targetUrl, msg));
      }
    }
  }
}

module.exports = { ProxyEngine };
