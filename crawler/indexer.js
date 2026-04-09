const natural = require('natural');
const { db } = require('../db/database');

const stemmer = natural.PorterStemmer;
const stopwords = new Set(natural.stopwords);

const deleteWordsForPage = db.prepare('DELETE FROM word_index WHERE page_id = ?');
const insertWordStmt = db.prepare(`
  INSERT INTO word_index (word, page_id, tf_score)
  VALUES (@word, @pageId, @tfScore)
  ON CONFLICT (word, page_id) DO UPDATE SET tf_score = excluded.tf_score
`);

class Indexer {
  tokenize(text) {
    if (!text || typeof text !== 'string') {
      return [];
    }
    const raw = text.toLowerCase().split(/[^a-z0-9]+/);
    const out = [];
    for (const token of raw) {
      if (token.length < 2 || token.length > 30) continue;
      if (stopwords.has(token)) continue;
      const stemmed = stemmer.stem(token);
      if (!stemmed || stemmed.length < 2) continue;
      out.push(stemmed);
    }
    return out;
  }

  computeTF(tokens) {
    const map = new Map();
    if (!tokens.length) return map;
    for (const t of tokens) {
      map.set(t, (map.get(t) || 0) + 1);
    }
    const n = tokens.length;
    for (const [w, c] of map) {
      map.set(w, c / n);
    }
    return map;
  }

  indexPage(pageId, bodyText) {
    const tokens = this.tokenize(bodyText || '');
    const tf = this.computeTF(tokens);
    deleteWordsForPage.run(pageId);
    const insertMany = db.transaction((pairs) => {
      for (const [word, tfScore] of pairs) {
        insertWordStmt.run({ word, pageId, tfScore });
      }
    });
    insertMany([...tf.entries()]);
  }
}

const indexer = new Indexer();

module.exports = {
  Indexer,
  indexer,
};
