/* Deterministic, occurrence-aware review matching; never guess partial duplicates. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./core.js'), require('./diff.js'));
  else root.MiniCatRevision = factory(root.MiniCatCore, root.MiniCatDiff);
})(typeof self !== 'undefined' ? self : this, function (Core, Diff) {
  'use strict';
  function buildPlan(segments, pairs, comments) {
    const existing = new Map(), incoming = new Map();
    segments.forEach((s, i) => {
      const key = Core.normalizeCJK(s.src);
      if (!existing.has(key)) existing.set(key, []);
      existing.get(key).push(i);
    });
    pairs.forEach((p, i) => {
      const key = Core.normalizeCJK(p.zh);
      if (!key) return;
      if (!incoming.has(key)) incoming.set(key, []);
      incoming.get(key).push(i);
    });
    for (const [key, rows] of incoming) {
      const targets = existing.get(key) || [];
      if (targets.length && (targets.length > 1 || rows.length > 1) && targets.length !== rows.length) {
        throw new Error(`重复原文无法唯一匹配：「${String(pairs[rows[0]].zh).slice(0, 60)}」本项目 ${targets.length} 段，文件 ${rows.length} 段。请导入包含全部同文段落且顺序一致的文件。`);
      }
    }
    const occurrence = new Map(), pairTargets = new Map(), plan = [];
    let matched = 0, revised = 0, unchanged = 0, fresh = 0;
    pairs.forEach((p, pairIndex) => {
      const key = Core.normalizeCJK(p.zh);
      if (!key) return;
      const ordinal = occurrence.get(key) || 0;
      occurrence.set(key, ordinal + 1);
      const targets = existing.get(key) || [];
      const en = typeof p.en === 'string' ? p.en.trim() : '';
      if (targets.length) {
        const idx = targets[ordinal];
        pairTargets.set(pairIndex, idx);
        if (!en) return;
        matched++;
        if (!Diff.sameText(segments[idx].tgt, en)) {
          revised++;
          plan.push({ kind: 'rev', idx, en, pair: p });
        } else unchanged++;
      } else if (en) {
        const idx = segments.length + fresh++;
        pairTargets.set(pairIndex, idx);
        plan.push({ kind: 'new', idx, zh: p.zh, en, pair: p });
      }
    });
    const mappedComments = [];
    for (const c of comments || []) {
      // A Word row may have many comments: each uses its row's target, not a new occurrence.
      const idx = pairTargets.get(c.pairIndex);
      if (idx == null) throw new Error('批注无法定位到句段；请提供该行原文和译文后重新导入。');
      const author = c.author || '批注';
      const duplicate = [...(segments[idx] && segments[idx].comments || []), ...mappedComments.filter(x => x.idx === idx)]
        .some(x => x.text === c.text && (x.author || '批注') === author);
      if (!duplicate) mappedComments.push({ ...c, author, idx });
    }
    return { plan, comments: mappedComments, matched, revised, unchanged, fresh };
  }
  return { buildPlan };
});
