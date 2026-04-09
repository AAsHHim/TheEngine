const { getInboundLinkCount } = require('../db/database');

class Ranker {
  scorePageRank(url) {
    const inbound = getInboundLinkCount(url);
    return Math.min(inbound * 0.1, 2.0);
  }

  scoreFreshness(crawledAt) {
    if (!crawledAt) return 0;
    const t = new Date(crawledAt).getTime();
    if (Number.isNaN(t)) return 0;
    const ageMs = Date.now() - t;
    const day = 24 * 60 * 60 * 1000;
    const week = 7 * day;
    if (ageMs < day) return 0.5;
    if (ageMs < week) return 0.2;
    return 0;
  }

  scoreTitleMatch(title, queryWords) {
    if (!title || !queryWords || !queryWords.length) return 0;
    const lower = String(title).toLowerCase();
    let bonus = 0;
    for (const w of queryWords) {
      if (!w) continue;
      if (lower.includes(String(w).toLowerCase())) {
        bonus += 1.5;
      }
    }
    return bonus;
  }

  rank(queryWords, pageRows) {
    const words = queryWords || [];
    const scored = pageRows.map((row) => {
      const tfSum = Number(row.tf_sum) || 0;
      const pr = this.scorePageRank(row.url);
      const fresh = this.scoreFreshness(row.crawled_at);
      const titleBonus = this.scoreTitleMatch(row.title, words);
      const score = tfSum + pr + fresh + titleBonus;
      return {
        ...row,
        score,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}

const ranker = new Ranker();

module.exports = {
  Ranker,
  ranker,
};
