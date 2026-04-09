const { crawler } = require('./crawler');
const { getStats } = require('../db/database');

class Scheduler {
  constructor() {
    this.running = false;
    this.timer = null;
    this.crawlIntervalMs = Number(process.env.CRAWL_INTERVAL_MS) || 5000;
  }

  isRunning() {
    return this.running;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._scheduleTick(0);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  _scheduleTick(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this._tick(), delayMs);
  }

  async _tick() {
    if (!this.running) return;

    const { queueSize } = getStats();
    if (queueSize === 0) {
      console.log('[TheEngine] Queue empty, waiting...');
      this._scheduleTick(30000);
      return;
    }

    try {
      await crawler.crawlBatch(3);
    } catch (err) {
      console.warn('[TheEngine] crawlBatch error:', err.message);
    }

    this._scheduleTick(this.crawlIntervalMs);
  }
}

const scheduler = new Scheduler();

module.exports = {
  Scheduler,
  scheduler,
};
