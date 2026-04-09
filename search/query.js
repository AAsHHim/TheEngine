const { searchPages } = require('../db/database');
const { indexer } = require('../crawler/indexer');
const { ranker } = require('./ranker');

function dedupeWords(words) {
  return [...new Set(words.filter(Boolean))];
}

class QueryEngine {
  parseQuery(queryString) {
    if (!queryString || typeof queryString !== 'string') {
      return [];
    }
    return dedupeWords(indexer.tokenize(queryString));
  }

  async execute(queryWords, limit = 20) {
    const words = dedupeWords(queryWords || []);
    if (words.length === 0) {
      return [];
    }
    let rows = searchPages(words);
    if (rows.length === 0 && words.length > 1) {
      rows = searchPages([words[0]]);
    }
    const ranked = ranker.rank(words, rows);
    return ranked.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
  }

  async search(queryString, limit = 20) {
    const words = this.parseQuery(queryString);
    if (words.length === 0) {
      return [];
    }
    const rows = await this.execute(words, limit);
    return rows.map((r) => ({
      title: r.title || '',
      url: r.url,
      description: r.description || '',
      score: r.score,
      crawledAt: r.crawled_at,
    }));
  }
}

const queryEngine = new QueryEngine();

module.exports = {
  QueryEngine,
  queryEngine,
};
