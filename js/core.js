/* Mini-CAT core: normalization, similarity, segmentation, term matching.
 * Pure functions only — no DOM, no storage. Usable from browser and Node (tests). */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.MiniCatCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- normalization ---------- */

  // Characters whose width variants should be unified for matching
  const WIDTH_MAP = {
    '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':',
    '（': '(', '）': ')', '“': '"', '”': '"', '‘': "'", '’': "'",
    '《': '<', '》': '>', '、': ',', '　': ' ', '—': '-', '～': '~', '．': '.'
  };

  function normalize(s) {
    if (!s) return '';
    let out = '';
    for (const ch of s) {
      out += WIDTH_MAP[ch] !== undefined ? WIDTH_MAP[ch] : ch;
    }
    return out
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '') // zero-width
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim();
  }

  // Normalized form for CJK matching: spaces are often insertion points in Chinese,
  // so drop them entirely for similarity purposes.
  function normalizeCJK(s) {
    return normalize(s).replace(/ /g, '');
  }

  /* ---------- similarity ---------- */

  function bigrams(s) {
    const t = normalizeCJK(s);
    const out = new Set();
    if (t.length === 1) { out.add(t); return out; }
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  }

  function diceCoefficient(a, b) {
    const A = bigrams(a), B = bigrams(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return (2 * inter) / (A.size + B.size);
  }

  // Bounded Levenshtein: returns dist, or null if it certainly exceeds maxDist.
  function levenshteinBounded(a, b, maxDist) {
    const m = a.length, n = b.length;
    if (Math.abs(m - n) > maxDist) return null;
    if (m === 0) return n <= maxDist ? n : null;
    if (n === 0) return m <= maxDist ? m : null;
    let prev = new Array(n + 1), curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      let rowMin = curr[0];
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= n; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        curr[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > maxDist) return null; // early abandon
      const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n] <= maxDist ? prev[n] : null;
  }

  // Similarity 0..1 based on normalized edit distance (OmegaT-style).
  function editSimilarity(a, b) {
    const x = normalizeCJK(a), y = normalizeCJK(b);
    if (x === y) return 1;
    if (!x.length || !y.length) return 0;
    const dist = levenshteinBounded(x, y, Math.floor(Math.max(x.length, y.length) * 0.55));
    if (dist === null) return Math.max(0, 1 - Math.max(x.length, y.length) * 0.45 / Math.max(x.length, y.length));
    return 1 - dist / Math.max(x.length, y.length);
  }

  /* Punctuation-light similarity: CAT tools penalize punctuation diffs lightly,
   * so if the punctuation-stripped forms agree better, take the better score. */
  function stripPunct(s) {
    return s.replace(/[\p{P}\p{S}]/gu, '');
  }

  // Combined match score used by the TM engine, 0..100.
  // Exact → 100. Otherwise edit distance similarity (Dice only as a cheap gate).
  function matchScore(source, candidate) {
    const s = normalizeCJK(source), c = normalizeCJK(candidate);
    if (!s || !c) return 0;
    if (s === c) return 100;
    const ratio = Math.min(s.length, c.length) / Math.max(s.length, c.length);
    if (ratio < 0.34) return 0;                       // length gate: cannot be ≥50%
    if (diceCoefficient(source, candidate) < 0.18) return 0; // cheap gate
    let sim = editSimilarity(source, candidate);
    const sp = stripPunct(s), cp = stripPunct(c);
    if (sp && cp && (sp !== s || cp !== c)) {
      if (sp === cp) sim = 1;                          // punctuation-only difference
      else sim = Math.max(sim, editSimilarity(sp, cp) * 0.99);
    }
    return Math.round(sim * 100);
  }

  /* Match band labels, following common CAT conventions (MateCat/OmegaT style). */
  function matchBand(score) {
    if (score >= 100) return { key: 'exact', label: '100%', cls: 'm-exact' };
    if (score >= 95) return { key: 'near', label: score + '%', cls: 'm-near' };
    if (score >= 75) return { key: 'fuzzy-hi', label: score + '%', cls: 'm-hi' };
    if (score >= 50) return { key: 'fuzzy-lo', label: score + '%', cls: 'm-lo' };
    return { key: 'none', label: '无匹配', cls: 'm-none' };
  }

  /* ---------- TM index ---------- */

  /* Inverted bigram index over TM entries for fast candidate generation.
   * entries: [{id, src, srcLen, grams:[...]}] */
  function createTMIndex(entries) {
    const gramToIds = new Map();
    function add(e) {
      for (const g of e.grams) {
        let arr = gramToIds.get(g);
        if (!arr) { arr = []; gramToIds.set(g, arr); }
        arr.push(e.id);
      }
    }
    for (const e of entries) add(e);
    return {
      size: entries.length,
      add,
      // Shortlist candidate ids sharing enough bigrams with the query.
      candidates(source, limit) {
        const grams = [...bigrams(source)];
        if (!grams.length) return [];
        const counts = new Map();
        for (const g of grams) {
          const arr = gramToIds.get(g);
          if (!arr) continue;
          for (const id of arr) counts.set(id, (counts.get(id) || 0) + 1);
        }
        // Rank by shared-gram count relative to query gram count
        const scored = [];
        for (const [id, c] of counts) {
          scored.push([id, c / grams.length]);
        }
        scored.sort((x, y) => y[1] - x[1]);
        return scored.slice(0, limit || 80).map(x => x[0]);
      }
    };
  }

  /* Rank all TM entries against a source segment; returns [{entry, score}] ≥ minScore.
   * Optimized: query normalization/bigrams computed once; candidate grams reused. */
  function findMatches(source, entries, index, minScore, topN) {
    minScore = minScore || 50; topN = topN || 5;
    const q = normalizeCJK(source);
    if (!q) return [];
    const qGrams = bigrams(source);
    const qPlain = stripPunct(q);
    const candIds = new Set(index.candidates(source, 120));
    const out = [];
    for (const e of entries) {
      let score;
      if (e.srcNorm === q) score = 100;
      else {
        if (!candIds.has(e.id)) continue;
        const len = e.srcNorm.length, ql = q.length;
        const ratio = Math.min(len, ql) / Math.max(len, ql);
        if (ratio < 0.34) continue;
        // dice with precomputed grams (entries may carry .grams or raw .bigrams)
        const eGrams = e.gramSet || (e.gramSet = new Set(e.grams || e.bigrams || []));
        if (!eGrams.size) continue;
        let inter = 0;
        for (const g of qGrams) if (eGrams.has(g)) inter++;
        const dice = (2 * inter) / (qGrams.size + eGrams.size);
        if (dice < 0.18) continue;
        let sim = editSimilarity(q, e.srcNorm);
        const ePlain = e.plain || (e.plain = stripPunct(e.srcNorm));
        if (qPlain !== q || ePlain !== e.srcNorm) {
          if (qPlain && ePlain && qPlain === ePlain) sim = 1;
          else sim = Math.max(sim, editSimilarity(qPlain, ePlain) * 0.99);
        }
        score = Math.round(sim * 100);
      }
      if (score >= minScore) out.push({ entry: e, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topN);
  }

  /* ---------- segmentation ---------- */

  // Split into sentences, keeping delimiters. Works for zh (。！？；…) and latin (.!?;).
  function splitSentences(paragraph) {
    const parts = [];
    let buf = '';
    const END = new Set(['。', '！', '？', '；', '…', '.', '!', '?', ';']);
    const chars = [...paragraph];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      buf += ch;
      if (END.has(ch)) {
        // latin abbrev/decimal guard: digit.digit or letter. (single upper letter)
        const next = chars[i + 1];
        if (ch === '.' && next && /\d/.test(next)) continue;
        if (ch === '.' && next && /[A-Z]/.test(chars[i - 1] || '') && (!chars[i + 1] || /\s/.test(chars[i + 1])) && buf.length <= 3) continue;
        if (ch === '…') { // absorb ellipsis runs
          while (chars[i + 1] === '…' || chars[i + 1] === '.') { buf += chars[i + 1]; i++; }
        }
        parts.push(buf); buf = '';
      }
    }
    if (buf.trim()) parts.push(buf);
    return parts;
  }

  // Segment a whole text: paragraphs → sentences; short sentences merged
  // with their neighbour WITHIN the same paragraph only.
  function segmentText(text, minChars) {
    minChars = minChars || 6;
    const result = [];
    const paras = String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
    for (const p of paras) {
      const sents = splitSentences(p);
      const local = [];
      let acc = '';
      for (const s of sents) {
        if (acc && [...(acc + s)].length < minChars) { acc += s; continue; }
        if (acc) local.push(acc);
        acc = s;
      }
      if (acc) {
        if (local.length && [...acc].length < minChars) local[local.length - 1] += acc;
        else local.push(acc);
      }
      result.push(...local);
    }
    return result;
  }

  /* ---------- terminology matching ---------- */

  /* Find term hits in a text. terms: [{id, zh, en, note}]. Longest-first scan;
   * overlapping matches resolved by greediness on start position. */
  function findTerms(text, terms) {
    const hits = [];
    if (!text) return hits;
    const sorted = terms.filter(t => t.zh).sort((a, b) => b.zh.length - a.zh.length);
    const taken = []; // [start, end) ranges already claimed
    function overlaps(s, e) {
      for (const r of taken) if (s < r[1] && e > r[0]) return true;
      return false;
    }
    for (const t of sorted) {
      let from = 0;
      const needle = t.zh;
      for (;;) {
        const i = text.indexOf(needle, from);
        if (i === -1) break;
        if (!overlaps(i, i + needle.length)) {
          taken.push([i, i + needle.length]);
          hits.push({ term: t, start: i, end: i + needle.length });
        }
        from = i + needle.length;
      }
    }
    hits.sort((a, b) => a.start - b.start);
    return hits;
  }

  /* ---------- misc ---------- */

  function charCount(s) { return [...String(s || '')].length; }
  function cjkCount(s) { const m = String(s || '').match(/[\u4e00-\u9fff\u3400-\u4dbf]/g); return m ? m.length : 0; }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return {
    normalize, normalizeCJK, bigrams, diceCoefficient, levenshteinBounded,
    editSimilarity, matchScore, matchBand, createTMIndex, findMatches,
    splitSentences, segmentText, findTerms, charCount, cjkCount, escapeHtml
  };
});
