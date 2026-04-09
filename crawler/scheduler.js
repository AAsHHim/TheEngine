const { getSetting, setSetting } = require('../db/database');
const { crawler } = require('./crawler');

class Scheduler {
  constructor(crawlerInstance) {
    this.crawler = crawlerInstance;
    this.running = false;
    this.intervalHandle = null;
    this.lastCrawledUrl = null;
    this.crawlCount = 0;
    this._loopInProgress = false;
  }

  init() {
    const mode = getSetting('crawl_mode', 'manual');
    console.log(`[TheEngine] Crawl mode on startup: ${mode}`);
    if (mode === 'auto') {
      this.start();
    } else {
      console.log('[TheEngine] Manual mode — crawler is PAUSED. Use the UI or API to crawl.');
    }
  }

  start() {
    if (this.running) return;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = true;
    setSetting('crawl_mode', 'auto');
    const interval = Math.max(1000, parseInt(process.env.CRAWL_INTERVAL_MS || '5000', 10));
    this.intervalHandle = setInterval(() => void this.loop(), interval);
    console.log('[TheEngine] ✦ Auto-crawl STARTED');
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.running) {
      console.log('[TheEngine] ⏸ Auto-crawl STOPPED — switched to manual mode');
    }
    this.running = false;
    setSetting('crawl_mode', 'manual');
  }

  async crawlOnce(batchSize = 3) {
    if (this.crawler.isCrawling) {
      return { skipped: true, reason: 'Already crawling' };
    }
    const results = await this.crawler.crawlBatch(batchSize);
    if (results.length > 0) {
      this.lastCrawledUrl = results[results.length - 1].url;
      this.crawlCount += results.length;
    }
    return { crawled: results.length, urls: results.map((r) => r.url) };
  }

  async loop() {
    if (this._loopInProgress) return;
    const mode = getSetting('crawl_mode', 'manual');
    if (mode !== 'auto') {
      this.stop();
      return;
    }
    if (this.crawler.isCrawling) return;
    this._loopInProgress = true;
    try {
      const results = await this.crawler.crawlBatch(3, {
        parallel: false,
        shouldContinue: () => getSetting('crawl_mode', 'manual') === 'auto',
      });
      if (getSetting('crawl_mode', 'manual') !== 'auto') {
        this.stop();
        return;
      }
      if (results.length > 0) {
        this.lastCrawledUrl = results[results.length - 1].url;
        this.crawlCount += results.length;
      }
    } finally {
      this._loopInProgress = false;
    }
  }

  getStatus() {
    return {
      mode: getSetting('crawl_mode', 'manual'),
      running: this.running,
      lastCrawledUrl: this.lastCrawledUrl,
      crawlCount: this.crawlCount,
    };
  }

  isRunning() {
    return this.running;
  }
}

const scheduler = new Scheduler(crawler);

module.exports = {
  Scheduler,
  scheduler,
};
