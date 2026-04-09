const { seedUrlsIfEmpty, reseedQueue } = require('../db/database');

const SEED_URLS = [
  'https://en.wikipedia.org',
  'https://news.ycombinator.com',
  'https://www.bbc.com/news',
  'https://www.reddit.com/r/technology',
  'https://stackoverflow.com',
  'https://github.com/trending',
  'https://arxiv.org',
  'https://www.wired.com',
  'https://arstechnica.com',
  'https://developer.mozilla.org',
];

function initSeeds() {
  seedUrlsIfEmpty(SEED_URLS, 5);
}

function seedQueueReseed() {
  reseedQueue(SEED_URLS, 5);
}

module.exports = {
  SEED_URLS,
  initSeeds,
  seedQueueReseed,
};
