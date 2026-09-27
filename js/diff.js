/* Mini-CAT diff.js — 词级 LCS 差分，零依赖。
 * 用于修订痕迹：比较两个译文版本，产出 eq/del/ins 操作序列（可渲染为
 * Word 原生修订 w:del/w:ins，或界面内联高亮）。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.MiniCatDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function tokenize(s) {
    return String(s || '').split(/\s+/).filter(Boolean);
  }

  /* ops: [{t:'eq'|'del'|'ins', text}] — text 已按空格重连 */
  function diffWords(oldText, newText) {
    const a = tokenize(oldText), b = tokenize(newText);
    const n = a.length, m = b.length;
    // LCS DP（句段级短文本，O(n·m) 足够）
    const dp = new Array((n + 1) * (m + 1)).fill(0);
    const W = m + 1;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
      }
    }
    const raw = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { raw.push({ t: 'eq', w: a[i] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { raw.push({ t: 'del', w: a[i] }); i++; }
      else { raw.push({ t: 'ins', w: b[j] }); j++; }
    }
    while (i < n) { raw.push({ t: 'del', w: a[i] }); i++; }
    while (j < m) { raw.push({ t: 'ins', w: b[j] }); j++; }
    // 合并相邻同类型
    const ops = [];
    for (const op of raw) {
      const last = ops[ops.length - 1];
      if (last && last.t === op.t) last.text += (last.text ? ' ' : '') + op.w;
      else ops.push({ t: op.t, text: op.w });
    }
    return ops;
  }

  /* 无变化判定：归一化空白后一致 */
  function sameText(a, b) {
    return String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();
  }

  /* 变更统计 */
  function diffStats(ops) {
    let del = 0, ins = 0;
    for (const o of ops) {
      if (o.t === 'del') del += o.text.split(' ').length;
      if (o.t === 'ins') ins += o.text.split(' ').length;
    }
    return { del, ins, changed: del + ins > 0 };
  }

  return { diffWords, sameText, diffStats };
});
