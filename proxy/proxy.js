const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const cookieJar = require('./cookieJar');
const { getInterceptScript } = require('./intercept');

const AXIOS_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  // Omit brotli ("br"): Node/axios Brotli decompression often throws Zlib "unexpected end of file"
  // on truncated or quirky upstream responses; gzip/deflate are enough for the proxy.
  'Accept-Encoding': 'gzip, deflate',
  DNT: '1',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

/**
 * Follow redirects manually; updates cookie jar per response.
 * @returns {Promise<{ data: any, finalUrl: string, statusCode: number, headers: object }>}
 */
async function followUpstreamFetch(startUrl, options = {}) {
  const followRedirects = options.followRedirects !== false;
  const maxHops = options.maxHops ?? 10;
  let currentUrl = startUrl;
  let method = String(options.method || 'GET').toUpperCase();
  let data = options.data;
  const baseHeaders = { ...AXIOS_HEADERS, ...(options.headers || {}) };
  const responseType = options.responseType || 'arraybuffer';

  const oneHop = async (url) => {
    const jarCookie = await cookieJar.getCookieHeader(url);
    const headers = { ...baseHeaders };
    if (options.cookieHeader) {
      headers.cookie = options.cookieHeader;
    } else if (jarCookie) {
      headers.cookie = jarCookie;
    }
    const res = await axios({
      method,
      url,
      data: method !== 'GET' && method !== 'HEAD' ? data : undefined,
      headers,
      maxRedirects: 0,
      responseType,
      validateStatus: () => true,
      timeout: options.timeout ?? 15000,
    });
    const responseUrl = res.request?.res?.responseUrl || res.config?.url || url;
    await cookieJar.storeCookies(responseUrl, res.headers['set-cookie']);
    return { res, responseUrl };
  };

  if (!followRedirects) {
    const { res, responseUrl } = await oneHop(currentUrl);
    return {
      data: res.data,
      finalUrl: responseUrl,
      statusCode: res.status,
      headers: res.headers,
    };
  }

  for (let hop = 0; hop < maxHops; hop++) {
    const { res, responseUrl } = await oneHop(currentUrl);
    const status = res.status;
    if (REDIRECT_STATUSES.has(status)) {
      const loc = res.headers.location;
      if (!loc) break;
      if (status === 303 || ((status === 302 || status === 301) && method !== 'GET')) {
        method = 'GET';
        data = undefined;
      }
      currentUrl = new URL(loc, currentUrl).href;
      continue;
    }

    return {
      data: res.data,
      finalUrl: responseUrl,
      statusCode: status,
      headers: res.headers,
    };
  }

  throw new Error('Too many redirects');
}

class ProxyEngine {
  bytesToText(buffer, contentType) {
    return bufferToString(buffer, contentType);
  }

  constructor() {
    this.blockedDomains = [
      'google-analytics.com',
      'doubleclick.net',
      'googlesyndication.com',
      'adservice.google.com',
      'facebook.com',
      'connect.facebook.net',
    ];
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

  proxyApiLink(baseProxyUrl, absoluteUrl) {
    if (!absoluteUrl) return null;
    return `${baseProxyUrl}/proxy/api?url=${this.encodeProxyUrl(absoluteUrl)}`;
  }

  rewriteInlineScripts(scriptText, baseProxyUrl) {
    if (!scriptText) return scriptText;
    let t = scriptText;
    t = t.replace(/fetch\s*\(\s*(['"])(https?:\/\/[^'"]*)\1/gi, (full, q, url) => {
      return `fetch(${q}${this.proxyApiLink(baseProxyUrl, url)}${q}`;
    });
    t = t.replace(/\.open\s*\(\s*(['"][A-Za-z]+['"])\s*,\s*(['"])(https?:\/\/[^'"]*)\2/gi, (full, methodArg, q, url) => {
      return `.open(${methodArg}, ${q}${this.proxyApiLink(baseProxyUrl, url)}${q}`;
    });
    t = t.replace(/window\.location\.href\s*=\s*(['"])(https?:\/\/[^'"]*)\1/gi, (full, q, url) => {
      return `window.location.href = ${q}${this.proxyLink(baseProxyUrl, url)}${q}`;
    });
    t = t.replace(/(^|[^.\w])location\.href\s*=\s*(['"])(https?:\/\/[^'"]*)\2/gi, (full, pre, q, url) => {
      return `${pre}location.href = ${q}${this.proxyLink(baseProxyUrl, url)}${q}`;
    });
    return t;
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
    const intercept = getInterceptScript(baseProxyUrl, targetUrl);
    if ($('head').length === 0) {
      $('html').prepend('<head></head>');
    }
    $('head').prepend(intercept);

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

    $('script, link').each((_, el) => {
      $(el).removeAttr('integrity');
    });

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
    $('meta[http-equiv]').each((_, el) => {
      const h = ($(el).attr('http-equiv') || '').toLowerCase();
      if (h === 'content-security-policy') $(el).remove();
    });

    $('script').each((_, el) => {
      const $el = $(el);
      if ($el.attr('src')) return;
      const txt = $el.html();
      $el.html(this.rewriteInlineScripts(txt, baseProxyUrl));
    });

    return $.html();
  }

  rewriteCss(css, targetUrl, baseProxyUrl) {
    const base = targetUrl;
    return css.replace(/url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (full, _q, inner) => {
      const raw = String(inner).trim();
      if (raw.startsWith('data:') || raw.startsWith('#')) return full;
      const abs = this.resolveUrl(raw, base);
      if (!abs) return full;
      const proxied = /^https?:\/\//i.test(abs) ? this.proxyLink(baseProxyUrl, abs) : abs;
      return `url("${proxied}")`;
    });
  }

  /**
   * @param {string} targetUrl
   * @param {object} [requestOptions]
   * @param {string} [requestOptions.method]
   * @param {any} [requestOptions.body]
   * @param {object} [requestOptions.headers]
   * @param {string} [requestOptions.cookieHeader]
   */
  async fetchPage(targetUrl, requestOptions = {}) {
    if (this.isBlockedDomain(targetUrl)) {
      const html = this.blockedPageHtml(targetUrl);
      return {
        html,
        finalUrl: targetUrl,
        statusCode: 403,
        contentType: 'text/html; charset=utf-8',
        rawHeaders: {},
        isError: false,
        blocked: true,
      };
    }

    const headers = { ...requestOptions.headers };
    const method = requestOptions.method || 'GET';
    const data = requestOptions.body;

    try {
      const result = await followUpstreamFetch(targetUrl, {
        method,
        data,
        headers,
        cookieHeader: requestOptions.cookieHeader,
        responseType: 'arraybuffer',
      });

      const ct = result.headers['content-type'] || '';
      const finalUrl = result.finalUrl || targetUrl;

      if (result.statusCode >= 400 || result.data == null) {
        return {
          html: this.buildErrorPageHtml(targetUrl, `HTTP ${result.statusCode}`),
          finalUrl,
          statusCode: result.statusCode,
          contentType: ct,
          rawHeaders: result.headers,
          isError: true,
        };
      }

      const html = bufferToString(result.data, ct);
      return {
        html,
        finalUrl,
        statusCode: result.statusCode,
        contentType: ct,
        rawHeaders: result.headers,
        isError: false,
      };
    } catch (err) {
      const msg = err.response
        ? `HTTP ${err.response.status}`
        : err.code || err.message || String(err);
      return {
        html: this.buildErrorPageHtml(targetUrl, msg),
        finalUrl: targetUrl,
        statusCode: err.response?.status || 502,
        contentType: 'text/html; charset=utf-8',
        rawHeaders: {},
        isError: true,
      };
    }
  }

  /**
   * Fetch upstream and return buffer + metadata (for GET /proxy content-type branching).
   */
  async fetchUpstreamBuffer(targetUrl, requestOptions = {}) {
    if (this.isBlockedDomain(targetUrl)) {
      return { ok: false, error: 'blocked', blocked: true };
    }
    try {
      const result = await followUpstreamFetch(targetUrl, {
        method: requestOptions.method || 'GET',
        data: requestOptions.body,
        headers: requestOptions.headers,
        cookieHeader: requestOptions.cookieHeader,
        responseType: 'arraybuffer',
        followRedirects: requestOptions.followRedirects,
      });
      const ct = result.headers['content-type'] || '';
      const finalUrl = result.finalUrl || targetUrl;
      if (
        requestOptions.followRedirects === false &&
        REDIRECT_STATUSES.has(result.statusCode) &&
        result.headers.location
      ) {
        return {
          ok: true,
          redirect: true,
          statusCode: result.statusCode,
          location: result.headers.location,
          headers: result.headers,
          finalUrl,
        };
      }
      if (result.statusCode >= 400 || result.data == null) {
        return { ok: false, error: `HTTP ${result.statusCode}`, statusCode: result.statusCode };
      }
      return {
        ok: true,
        buffer: Buffer.from(result.data),
        finalUrl,
        contentType: ct,
        statusCode: result.statusCode,
        headers: result.headers,
      };
    } catch (err) {
      const msg = err.response ? `HTTP ${err.response.status}` : err.code || err.message || String(err);
      return { ok: false, error: msg };
    }
  }

  /**
   * Single upstream request (no redirect follow). For POST /proxy redirect responses.
   */
  async singleHopFetch(targetUrl, requestOptions = {}) {
    if (this.isBlockedDomain(targetUrl)) {
      return { blocked: true };
    }
    try {
      return await followUpstreamFetch(targetUrl, {
        method: requestOptions.method || 'GET',
        data: requestOptions.body,
        headers: requestOptions.headers,
        cookieHeader: requestOptions.cookieHeader,
        responseType: 'arraybuffer',
        followRedirects: false,
      });
    } catch (err) {
      return { error: err };
    }
  }

  async fetchTextResource(targetUrl, requestOptions = {}) {
    if (this.isBlockedDomain(targetUrl)) {
      return { ok: false, error: 'blocked' };
    }
    try {
      const result = await followUpstreamFetch(targetUrl, {
        method: requestOptions.method || 'GET',
        headers: requestOptions.headers,
        cookieHeader: requestOptions.cookieHeader,
        responseType: 'arraybuffer',
      });
      const ct = result.headers['content-type'] || '';
      if (result.statusCode >= 400 || result.data == null) {
        return { ok: false, error: `HTTP ${result.statusCode}` };
      }
      const text = bufferToString(result.data, ct);
      return { ok: true, text, contentType: ct, finalUrl: result.finalUrl };
    } catch (err) {
      const msg = err.response ? `HTTP ${err.response.status}` : err.code || err.message || String(err);
      return { ok: false, error: msg };
    }
  }

  async pipeRawResponse(targetUrl, res, requestOptions = {}) {
    if (this.isBlockedDomain(targetUrl)) {
      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(403).send(this.blockedPageHtml(targetUrl));
    }
    try {
      let currentUrl = targetUrl;
      let method = String(requestOptions.method || 'GET').toUpperCase();
      let data = requestOptions.body;
      const baseHeaders = { ...AXIOS_HEADERS, ...(requestOptions.headers || {}) };
      if (requestOptions.cookieHeader) {
        baseHeaders.cookie = requestOptions.cookieHeader;
      }

      for (let hop = 0; hop < 10; hop++) {
        const jarCookie = await cookieJar.getCookieHeader(currentUrl);
        const headers = { ...baseHeaders };
        if (!headers.cookie && jarCookie) headers.cookie = jarCookie;

        const upstream = await axios({
          method,
          url: currentUrl,
          data: method !== 'GET' && method !== 'HEAD' ? data : undefined,
          headers,
          maxRedirects: 0,
          responseType: 'stream',
          validateStatus: () => true,
          timeout: 15000,
        });

        const responseUrl = upstream.request?.res?.responseUrl || upstream.config?.url || currentUrl;
        await cookieJar.storeCookies(responseUrl, upstream.headers['set-cookie']);

        if (REDIRECT_STATUSES.has(upstream.status)) {
          const loc = upstream.headers.location;
          upstream.data.destroy();
          if (!loc) break;
          const st = upstream.status;
          if (st === 303 || ((st === 302 || st === 301) && method !== 'GET')) {
            method = 'GET';
            data = undefined;
          }
          currentUrl = new URL(loc, currentUrl).href;
          continue;
        }

        if (upstream.status >= 400) {
          res.setHeader('X-Powered-By', 'TheEngine-Proxy');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res
            .status(502)
            .send(this.buildErrorPageHtml(targetUrl, `HTTP ${upstream.status}`));
        }

        const ct = upstream.headers['content-type'] || 'application/octet-stream';
        res.setHeader('X-Powered-By', 'TheEngine-Proxy');
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
        return;
      }

      res.setHeader('X-Powered-By', 'TheEngine-Proxy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(502).send(this.buildErrorPageHtml(targetUrl, 'Too many redirects'));
    } catch (err) {
      const msg = err.response ? `HTTP ${err.response.status}` : err.code || err.message || String(err);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('X-Powered-By', 'TheEngine-Proxy');
        res.status(502).send(this.buildErrorPageHtml(targetUrl, msg));
      }
    }
  }

  /**
   * Low-level API proxy: returns axios response after manual redirects, for /proxy/api.
   */
  async proxyApiRequest(targetUrl, requestOptions = {}) {
    if (this.isBlockedDomain(targetUrl)) {
      return { blocked: true };
    }
    const maxHops = requestOptions.maxHops ?? 10;
    let currentUrl = targetUrl;
    let method = String(requestOptions.method || 'GET').toUpperCase();
    let data = requestOptions.data;
    /** Server merges defaults + browser headers; jar supplies Cookie for upstream only. */
    const baseHeaders = { ...(requestOptions.headers || {}) };

    for (let hop = 0; hop < maxHops; hop++) {
      const jarCookie = await cookieJar.getCookieHeader(currentUrl);
      const headers = { ...baseHeaders };
      if (jarCookie) {
        headers.cookie = jarCookie;
      }

      const res = await axios({
        method,
        url: currentUrl,
        data: method !== 'GET' && method !== 'HEAD' ? data : undefined,
        headers,
        maxRedirects: 0,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        timeout: requestOptions.timeout ?? 60000,
      });

      const responseUrl = res.request?.res?.responseUrl || res.config?.url || currentUrl;
      await cookieJar.storeCookies(responseUrl, res.headers['set-cookie']);

      if (REDIRECT_STATUSES.has(res.status)) {
        const loc = res.headers.location;
        if (!loc) break;
        const st = res.status;
        if (st === 303 || ((st === 302 || st === 301) && method !== 'GET')) {
          method = 'GET';
          data = undefined;
        }
        currentUrl = new URL(loc, currentUrl).href;
        continue;
      }

      return { response: res, finalUrl: responseUrl };
    }
    return { error: new Error('redirect loop') };
  }
}

module.exports = { ProxyEngine, AXIOS_HEADERS };
