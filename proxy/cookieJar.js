const { CookieJar } = require('tough-cookie');

class CookieJarStore {
  constructor() {
    /** @type {Map<string, import('tough-cookie').CookieJar>} */
    this.jars = new Map();
  }

  getJar(domain) {
    if (!this.jars.has(domain)) {
      this.jars.set(domain, new CookieJar());
    }
    return this.jars.get(domain);
  }

  async getCookieHeader(url) {
    const domain = new URL(url).hostname;
    const jar = this.getJar(domain);
    return jar.getCookieStringSync(url);
  }

  async storeCookies(url, setCookieHeaders) {
    const domain = new URL(url).hostname;
    const jar = this.getJar(domain);
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const header of headers) {
      if (header) jar.setCookieSync(header, url);
    }
  }

  clear(domain) {
    this.jars.delete(domain);
  }
}

module.exports = new CookieJarStore();
