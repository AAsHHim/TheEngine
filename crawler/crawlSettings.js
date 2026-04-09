/**
 * Fetch mode for the crawler (Playwright vs plain HTTP).
 */

function getFetchMode() {
  return process.env.CRAWL_FETCH_MODE === 'http' ? 'http' : 'playwright';
}

module.exports = {
  getFetchMode,
};
