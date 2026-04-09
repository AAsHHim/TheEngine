/**
 * Manual vs automatic crawling.
 * - AUTO_CRAWL=true (env): start background scheduler on boot; optional seed queue.
 * - Otherwise: scheduler stays off until the user enables auto in the UI or POST /crawl/mode.
 */

let autoCrawl = process.env.AUTO_CRAWL === 'true';

function getAutoCrawl() {
  return autoCrawl;
}

function setAutoCrawl(enabled) {
  autoCrawl = Boolean(enabled);
  const { scheduler } = require('./scheduler');
  if (autoCrawl) {
    scheduler.start();
  } else {
    scheduler.stop();
  }
  return autoCrawl;
}

function getFetchMode() {
  return process.env.CRAWL_FETCH_MODE === 'http' ? 'http' : 'playwright';
}

module.exports = {
  getAutoCrawl,
  setAutoCrawl,
  getFetchMode,
};
