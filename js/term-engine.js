/* Vendored bilingual-term-extract statistical engine.
MIT License

Copyright (c) 2026 tanyaqiong31029

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
(function(root){
const factories={}, cache={}, process={env:{}};
factories["./util.js"]=function(require,module,exports){
'use strict';
/* Bilingual-Term-Extract —— 通用工具
 * charClass / weightedLen / isCJKText 适配自 multi-align（MIT License, tanyaqiong31029）
 */

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
}

/* ---------- 字符类别（长度加权 / 分句 / 语言检测共用） ---------- */
function charClass(cp) {
  if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0x20000 && cp <= 0x2FA1F)) return 'han';
  if (cp >= 0x3041 && cp <= 0x309F) return 'hira';
  if (cp >= 0x30A1 && cp <= 0x30FF) return 'kata';
  if ((cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0x1100 && cp <= 0x11FF) || (cp >= 0x3130 && cp <= 0x318F)) return 'hangul';
  if (cp >= 0x0E00 && cp <= 0x0E7F) return 'thai';
  if ((cp >= 0x0600 && cp <= 0x06FF) || (cp >= 0x0750 && cp <= 0x077F) ||
      (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF)) return 'arabic';
  if (cp >= 0x0900 && cp <= 0x097F) return 'deva';
  if (cp >= 0x0400 && cp <= 0x04FF) return 'cyrillic';
  if (cp >= 0x0370 && cp <= 0x03FF) return 'greek';
  if ((cp >= 0x0041 && cp <= 0x005A) || (cp >= 0x0061 && cp <= 0x007A) ||
      (cp >= 0x00C0 && cp <= 0x024F) || (cp >= 0x1E00 && cp <= 0x1EFF) ||
      (cp >= 0x0100 && cp <= 0x017F)) return 'latin';
  if ((cp >= 0x0030 && cp <= 0x0039) || (cp >= 0xFF10 && cp <= 0xFF19)) return 'digit';
  if (cp === 0x20 || cp === 0x09 || cp === 0x3000 || cp === 0x0A) return 'space';
  return 'other';
}

/* 加权长度：汉字 2.3 / 假名 1.8 / 谚文 2.1 / 泰文 1.6 / 其他 1.0 —— 使跨文种句长可比较 */
function weightedLen(text) {
  let w = 0;
  for (const ch of String(text || '')) {
    const c = charClass(ch.codePointAt(0));
    w += c === 'han' ? 2.3 : (c === 'hira' || c === 'kata') ? 1.8 : c === 'hangul' ? 2.1 : c === 'thai' ? 1.6 : 1;
  }
  return w;
}

/* 粗略判断文本是否为 CJK 文种 */
function isCJKText(text) {
  const t = String(text || '');
  if (!t) return false;
  let cjk = 0, total = 0;
  for (const ch of t) {
    const c = charClass(ch.codePointAt(0));
    if (c === 'han' || c === 'hira' || c === 'kata') cjk++;
    if (c !== 'space' && c !== 'other' && c !== 'digit') total++;
  }
  return total > 0 && cjk / total > 0.3;
}

/* 语言代码归一：en-US → en，zh_CN → zh-CN（保留显式简繁） */
function normLang(lang) {
  let l = String(lang || '').trim().replace(/_/g, '-');
  if (!l) return '';
  const lower = l.toLowerCase();
  if (lower === 'zh' || lower === 'zh-hans') return 'zh-CN';
  if (lower === 'zh-hant' || lower === 'zh-tw' || lower === 'zh-hk') return lower === 'zh-hant' ? 'zh-TW' : l;
  const main = lower.split('-')[0];
  const KNOWN = ['en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'it', 'ru', 'ar', 'th', 'vi', 'id', 'ms', 'tr', 'nl', 'pl', 'uk'];
  if (KNOWN.includes(main)) return main;
  return l;
}

module.exports = { escapeXml, timestamp, charClass, weightedLen, isCJKText, normLang };

};
factories["./stopwords.js"]=function(require,module,exports){
'use strict';
/* Bilingual-Term-Extract —— 内置停用词
 * 用途：候选术语的边界过滤（首尾词元不得为停用词/虚词），词中间不检查——
 *       像 state of the art 这类含介词的真术语不会被误杀。
 *
 * 中文单字表的取舍原则（经过金标准基准校验）：
 *   只收「在术语首尾出现会造成大量垃圾候选、且几乎不参与真术语构成」的字。
 *   点/分/向/类/条/架/行/开/化/性/度/器/件/据/网/关/理/算/统/式/系 这些字
 *   高频出现在术语结尾或开头（节点、分析、向量、类型、条件、框架、执行、开发、
 *   自动化、可靠性、精度、服务器、数据、网关、推理、计算、系统、分布式），一律不收；
 *   收进来的字（的了着吗…）配合邻接熵过滤承担第一道垃圾拦截。
 */

const EN = new Set(('a,an,the,and,or,but,if,then,else,when,while,of,to,in,on,at,by,for,with,from,as,into,onto,upon,' +
  'about,above,below,over,under,between,among,through,during,before,after,since,until,till,against,within,without,' +
  'along,across,behind,beyond,around,near,off,out,up,down,' +
  'is,are,was,were,be,been,being,am,do,does,did,done,doing,have,has,had,having,' +
  'will,would,shall,should,can,could,may,might,must,ought,' +
  'not,nor,no,yes,so,too,very,than,there,here,' +
  'i,me,my,mine,we,us,our,ours,you,your,yours,he,him,his,she,her,hers,it,its,they,them,their,theirs,' +
  'this,that,these,those,what,which,who,whom,whose,why,how,' +
  'all,any,both,either,neither,each,every,few,more,most,other,others,some,such,only,own,same,' +
  'also,just,even,still,already,yet,again,further,once,per,via,' +
  's,t,d,ll,re,ve,m,o,nor').split(','));

/* 中文单字虚词（首尾过滤用）。刻意精简，见文件头说明。 */
const ZH_CHARS = new Set((
  '的了呢吗吧啊呀哦嘛啦呐哇哪么' +
  '之所以或并且但是既然如果虽而不但不仅只才都也又再挺很较颇最' +
  '况从于由作为此该各某每另些什' +
  '被让给叫允遭得获到展予' +
  '个辆艘颗滴丝毫县乡省城村镇'
).split(''));

/* 中文多字虚词/通用词：整个候选等于这些词时直接排除（补单字表删减的缺口） */
const ZH_WORDS = new Set(('我们,你们,他们,她们,它们,自己,大家,咱们,这个,那个,这些,那些,这样,那样,这样子,' +
  '可以,应该,需要,能够,可能,也许,大概,或许,必须,一定,肯定,确实,真的,好像,似乎,' +
  '如果,假如,要是,倘若,若是,只要,只有,除非,无论,不管,尽管,即使,就算,' +
  '因为,由于,因此,所以,于是,然后,接着,最后,首先,其次,再者,此外,另外,而且,并且,不过,但是,可是,然而,虽然,' +
  '同时,以及,比较,极其,差不多,相当,通过,经过,根据,依据,按照,依照,本着,为了,关于,对于,至于,鉴于,' +
  '现在,目前,当前,以后,之后,以前,之前,最近,近来,当时,这时,那时,' +
  '非常,十分,特别,尤其,更加,越来越,逐步,逐渐,渐渐,基本上,大体上,一般来说,总的来说,总之,' +
  '进行,予以,加以,作出,做出,成为,变成,作为,属于,包括,包含,具有,拥有,存在,出现,发生,形成,产生,引起,导致,造成').split(','));

function isStopEn(norm) { return EN.has(String(norm || '').toLowerCase()); }
function isZhStopChar(ch) { return ZH_CHARS.has(ch); }
function isZhStopWord(norm) { return ZH_WORDS.has(String(norm || '')); }

module.exports = { EN, ZH_CHARS, ZH_WORDS, isStopEn, isZhStopChar, isZhStopWord };

};
factories["./tokenizer.js"]=function(require,module,exports){
'use strict';
/* Bilingual-Term-Extract —— 分词器
 * 拉丁文：连续字母/数字/连字符/撇号为一个词元；CJK：逐字成词元（对齐与 n-gram 统一的粒度）。
 * norm 为小写 + 轻量单数折叠（仅用于统计与对齐，term 展示用 surface）。
 * brk 标记"此词元前存在子句标点"——候选 n-gram 不得跨越 brk。
 */
const U = require('./util.js');

/* 轻量单数折叠：保证统计一致性即可，不追求语言学正确 */
function foldSingular(w) {
  if (w.length < 4) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (/(ss|us|is)$/.test(w)) return w;
  if (/s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
  return w;
}

function isCJKChar(ch) {
  const c = U.charClass(ch.codePointAt(0));
  return c === 'han' || c === 'hira' || c === 'kata';
}

/* 子句标点：出现在词元之间即视为不可跨越的边界（词元内部的连字符不经过此处） */
const PUNCT_RE = /[\p{P}\p{S}]/u;

/* 分词：返回 [{surface, norm, cjk, brk, start, end}] */
function tokenize(text) {
  const t = String(text || '');
  const out = [];
  let i = 0, pendingBrk = false;
  const L = t.length;
  while (i < L) {
    const ch = t[i];
    if (isCJKChar(ch)) {
      out.push({ surface: ch, norm: ch, cjk: true, brk: pendingBrk, start: i, end: i + 1 });
      pendingBrk = false; i++;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(ch)) {
      // 累积拉丁/数字词元（允许内部连字符、撇号）
      let j = i + 1;
      while (j < L && /[\p{L}\p{N}'’-]/u.test(t[j]) && !isCJKChar(t[j])) j++;
      // 去掉首尾连字符（如 " -5 " 的孤立连字符）
      let s = i, e = j;
      while (s < e && /[-'’]/.test(t[s])) s++;
      while (e > s && /[-'’]/.test(t[e - 1])) e--;
      if (e > s) {
        const surface = t.slice(s, e);
        out.push({ surface, norm: foldSingular(surface.toLowerCase()), cjk: false, brk: pendingBrk, start: s, end: e });
      }
      pendingBrk = false; i = j;
      continue;
    }
    if (PUNCT_RE.test(ch)) pendingBrk = true;
    i++;
  }
  return out;
}

/* 词元列表 → 展示文本（拉丁以空格连接，CJK 直接拼接） */
function joinTokens(toks) {
  if (!toks || !toks.length) return '';
  if (toks.every(x => x.cjk)) return toks.map(x => x.surface).join('');
  return toks.map(x => x.surface).join(' ');
}

/* 词元列表 → 统计键（norm） */
function keyOf(toks) {
  if (!toks || !toks.length) return '';
  if (toks.every(x => x.cjk)) return toks.map(x => x.norm).join('');
  return toks.map(x => x.norm).join(' ');
}

module.exports = { tokenize, joinTokens, keyOf, foldSingular, isCJKChar };

};
factories["./candidates.js"]=function(require,module,exports){
'use strict';
/* Bilingual-Term-Extract —— 源语候选术语提取（统计召回）
 * 拉丁文：token n-gram + 边界停用词过滤 + 软化 C-value 嵌套折扣 + 大写专名加权
 * 中文：字 n-gram + 凝固度（min PMI）+ 邻接熵（左右）过滤
 * 设计目标：高召回 —— 精度交给 LLM 精筛阶段（见 SKILL.md）。
 * 方法论参考：TermSuite（C-value）、Termolator（统计+过滤）、bitext-lexind（词对齐投票）。
 */
const Tok = require('./tokenizer.js');
const SW = require('./stopwords.js');

const DEFAULTS = {
  minFreq: 2,        // 候选最低出现次数
  maxLatinN: 5,      // 拉丁候选最大词元数
  maxZhN: 6,         // 中文候选最大字数
  topN: 300,         // 输出候选上限
  minPMI: 1.2,       // 中文候选内凝度下限（自然对数）——硬过滤
  minEntropy: 0,     // 中文候选邻接熵下限——默认 0（仅作软评分）。文档级小语料中，
                     // 频次 2 的真术语常被固定邻字压成 0 熵（如"带宽"总在"的带宽"），硬过滤会误杀
  zhMinFreq: 2
};

function entropyOf(counts, total) {
  if (!total) return 0;
  let h = 0;
  for (const v of counts.values()) {
    const p = v / total;
    h -= p * Math.log(p);
  }
  return h;
}

function isPureDigit(norm) { return /^[0-9]+$/.test(norm); }

/* 主入口：pairs = [{src, tgt, conf}]，返回 {candidates, stats} */
function extractCandidates(pairs, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  const sents = pairs.map(p => Tok.tokenize(p.src));

  /* ---------- 字符级统计（中文 PMI / 邻接熵用） ---------- */
  const uni = new Map(), bi = new Map();
  let uniTotal = 0, biTotal = 0;
  for (const toks of sents) {
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (!tk.cjk) continue;
      uni.set(tk.norm, (uni.get(tk.norm) || 0) + 1);
      uniTotal++;
      if (i + 1 < toks.length && toks[i + 1].cjk && !toks[i + 1].brk) {
        const key = tk.norm + '\u0000' + toks[i + 1].norm;
        bi.set(key, (bi.get(key) || 0) + 1);
        biTotal++;
      }
    }
  }

  /* ---------- n-gram 频次与出现位置 ---------- */
  const map = new Map(); // key → cand 骨架
  function touch(key, kind, n) {
    let c = map.get(key);
    if (!c) {
      c = { key, kind, n, freq: 0, surfaces: new Map(), occurrences: [], capOcc: 0, spread: new Set(), _left: new Map(), _right: new Map() };
      map.set(key, c);
    }
    return c;
  }

  for (let si = 0; si < sents.length; si++) {
    const toks = sents[si];
    const T = toks.length;

    /* 拉丁 n-gram（1..maxLatinN）：全拉丁词元、不跨 brk、边界非停用词 */
    const maxN = opts.maxLatinN;
    for (let n = 1; n <= maxN; n++) {
      for (let s = 0; s + n <= T; s++) {
        const e = s + n;
        let ok = true, _allCap = true;
        for (let k = s; k < e; k++) {
          const tk = toks[k];
          if (tk.cjk) { ok = false; break; }
          if (k > s && tk.brk) { ok = false; break; } // 跨子句标点
          if (k > s && isPureDigit(tk.norm)) { ok = false; break; }
        }
        if (!ok) continue;
        const first = toks[s], last = toks[e - 1];
        if (isPureDigit(first.norm) || isPureDigit(last.norm)) continue;
        if (SW.isStopEn(first.norm) || SW.isStopEn(last.norm)) continue;
        // 单词候选：至少含一个字母、长度≥2、非停用词（已在上方保证）
        if (n === 1 && !/\p{L}/u.test(first.norm)) continue;
        if (n === 1 && first.norm.length < 2) continue;

        const key = Tok.keyOf(toks.slice(s, e));
        const c = touch(key, 'latin', n);
        c.freq++;
        c.spread.add(si);
        const surf = Tok.joinTokens(toks.slice(s, e));
        c.surfaces.set(surf, (c.surfaces.get(surf) || 0) + 1);
        c.occurrences.push({ pair: si, start: s, end: e });
        // 大写专名统计：n≥2 且所有字母词元首字母大写（排除句首影响：看非首词元或整词）
        if (n >= 2) {
          let capAll = true, hasAlpha = false;
          for (let k = s; k < e; k++) {
            const w = toks[k];
            if (/\p{L}/u.test(w.surface)) {
              hasAlpha = true;
              if (!/^\p{Lu}/u.test(w.surface)) capAll = false;
            }
          }
          if (hasAlpha && capAll) c.capOcc++;
        }
      }
    }

    /* 中文 n-gram（2..maxZhN）：连续 CJK 单字、不跨 brk、首尾非虚词 */
    for (let n = 2; n <= opts.maxZhN; n++) {
      for (let s = 0; s + n <= T; s++) {
        const e = s + n;
        if (!toks[s].cjk) continue;
        let ok = true;
        for (let k = s + 1; k < e; k++) {
          if (!toks[k].cjk || toks[k].brk) { ok = false; break; }
        }
        if (!ok) continue;
        if (SW.isZhStopChar(toks[s].norm) || SW.isZhStopChar(toks[e - 1].norm)) continue;
        const key = Tok.keyOf(toks.slice(s, e));
        const c = touch(key, 'cjk', n);
        c.freq++;
        c.spread.add(si);
        c.surfaces.set(key, (c.surfaces.get(key) || 0) + 1);
        c.occurrences.push({ pair: si, start: s, end: e });
        // 邻接熵：记录左右邻字（同句内且不跨 brk）
        const lc = s > 0 && toks[s - 1].cjk && !toks[s].brk ? toks[s - 1].norm : '#';
        const rc = e < T && toks[e].cjk && !toks[e].brk ? toks[e].norm : '#';
        c._left.set(lc, (c._left.get(lc) || 0) + 1);
        c._right.set(rc, (c._right.get(rc) || 0) + 1);
      }
    }
  }

  /* ---------- 过滤 + 特征计算 ---------- */
  const list = [];
  for (const c of map.values()) {
    if (c.freq < (c.kind === 'cjk' ? Math.max(opts.minFreq, opts.zhMinFreq) : opts.minFreq)) continue;
    if (c.kind === 'cjk') {
      if (SW.isZhStopWord(c.key)) continue;
      // 内凝度：候选内部相邻字对的 min PMI
      let minPMI = Infinity;
      for (let k = 0; k + 1 < c.n; k++) {
        const a = c.key[k], b = c.key[k + 1];
        const pxy = ((bi.get(a + '\u0000' + b) || 0) + 0.1) / (biTotal + 0.1 * uniTotal);
        const p = (uni.get(a) || 0) / uniTotal, q = (uni.get(b) || 0) / uniTotal;
        if (p <= 0 || q <= 0) { minPMI = -Infinity; break; }
        const pmi = Math.log(pxy / (p * q));
        if (pmi < minPMI) minPMI = pmi;
      }
      if (!isFinite(minPMI) || minPMI < opts.minPMI) continue;
      const le = entropyOf(c._left, c.freq), re = entropyOf(c._right, c.freq);
      const minEntropy = Math.min(le, re);
      if (minEntropy < opts.minEntropy) continue; // 默认 minEntropy=0，仅当显式调高时硬过滤
      c.minPMI = +minPMI.toFixed(3);
      c.minEntropy = +minEntropy.toFixed(3);
    }
    list.push(c);
  }

  /* ---------- 软化 C-value 嵌套折扣 ----------
   * 候选 c 若主要作为更长候选 d 的子串出现，则有效频次下调：
   * effFreq = f(c) − 0.6 × (1/p) × Σ f(d)，p 为包含 c 的更长候选数。
   * 小语料下不做完整 C-value（避免过度惩罚），系数 0.6 为折中。
   */
  for (const d of list) {
    if (d.n < 2) continue;
    // d 的所有真子串（拉丁子串 ≥1 词元，中文 ≥2 字）；排除 d 自身
    const minSub = d.kind === 'cjk' ? 2 : 1;
    for (let s = 0; s < d.n; s++) {
      for (let e = s + minSub; e <= d.n; e++) {
        if (s === 0 && e === d.n) continue;
        const subKey = d.kind === 'cjk'
          ? d.key.slice(s, e)
          : d.key.split(' ').slice(s, e).join(' ');
        const sub = map.get(subKey);
        if (sub && sub.freq >= opts.minFreq) {
          (sub._containers = sub._containers || []).push(d.freq);
        }
      }
    }
  }
  for (const c of list) {
    const cs = c._containers || [];
    let eff = c.freq;
    if (cs.length) {
      const sum = cs.reduce((a, b) => a + b, 0);
      eff = c.freq - 0.6 * (sum / cs.length);
    }
    c.effFreq = +Math.max(eff, 0.5).toFixed(2);
  }

  /* ---------- 打分排序 ---------- */
  for (const c of list) {
    let score;
    if (c.kind === 'latin') {
      const capRatio = c.freq ? c.capOcc / c.freq : 0;
      score = c.effFreq * (1 + 0.4 * (c.n - 1)) * (1 + 0.3 * Math.min(c.spread.size, 6) / 6);
      if (c.n >= 2 && capRatio >= 0.7) score *= 1.15;
      c.capRatio = +capRatio.toFixed(2);
    } else {
      const pmiF = Math.min(Math.max(c.minPMI / 3, 0.5), 1.4);
      const entF = Math.min(Math.max(c.minEntropy / 2.5, 0.4), 1.3);
      score = c.effFreq * (1 + 0.25 * (c.n - 2)) * pmiF * entF;
    }
    c.score = +score.toFixed(3);
    c.term = [...c.surfaces.entries()].sort((a, b) => b[1] - a[1])[0][0];
    c.norm = c.key;
  }

  list.sort((a, b) => b.score - a.score || b.freq - a.freq);
  const top = list.slice(0, opts.topN);
  top.forEach((c, i) => {
    c.id = 'c' + (i + 1);
    c.contexts = c.occurrences.slice(0, 3).map(o => ({
      pair: o.pair,
      src: pairs[o.pair].src,
      tgt: pairs[o.pair].tgt
    }));
  });

  return {
    candidates: top,
    stats: {
      sentences: sents.length,
      rawCandidates: list.length,
      returned: top.length,
      minFreq: opts.minFreq,
      topN: opts.topN
    }
  };
}

module.exports = { extractCandidates, DEFAULTS };

};
factories["./vote.js"]=function(require,module,exports){
'use strict';
/* Bilingual-Term-Extract —— 术语译文投票
 * 句级共现关联度（Dice）+ 合格词元连续段 + 跨度打分 + 两轮共识投票。
 *
 * 为什么不用 IBM Model 1 EM：文档级小语料上，EM 会把概率质量集中到高频虚词
 * （的/the 与几乎所有词共现），argmax 解码系统性偏向虚词（金标准实测全部对齐到"的"）。
 *
 * 算法要点（在金标准基准上迭代得出）：
 *   - Dice = 2·co/(dfT+dfF)：高频虚词天然低分；
 *   - 合格门槛：co ≥ 0.75·dfT（翻译成分须在多数出现句中伴随术语）+ Dice ≥ 0.3 + dfF ≥ 2；
 *   - brk（子句边界）只阻止跨度内部穿越，不阻止跨度起始（"，固件更新"的固是合法起点）；
 *   - 连续段的全部子跨度参与打分 Σdice − 0.3·max(0, 宽度−基准)；
 *   - 两轮共识：第一轮每处出现投最优 span；随后在票数并列时取「被包含者」为
 *     共识核，包含共识核的 span 改投共识核——抑制共现动词粘连（run machine learning /
 *     行机器学习），因为真术语核会在其他出现句中以更纯的形式独立胜出。
 * 方法论参考：bitext-lexind（词对齐→词条→过滤）、Anymalign（共现对齐）。
 */
const Tok = require('./tokenizer.js');
const U = require('./util.js');

const DEFAULTS = {
  slack: 3,          // 译文跨度最多比基准宽度多出的词元数
  coGate: 0.75,      // 合格门槛：co ≥ coGate·dfT（主闸：偶发同句词在此被挡）
  diceMin: 0.3,      // Dice 下限：只挡高频虚词；对多术语共享的字（网/器/边）
                     // dfF 会被其他术语稀释，门槛必须低（0.5 会把"物联网"的网踢出局）
  widthPenalty: 0.3  // 超出基准宽度后每个词元的罚分：须低于共享字的真实 Dice（~0.57），
                     // 否则"云服务器"会被裁成"云服务"
};

function voteTranslations(cands, pairs, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  const tgtToks = pairs.map(p => Tok.tokenize(p.tgt));
  const tgtCJK = pairs.length > 0 && U.isCJKText(pairs.map(p => p.tgt).join(''));

  /* 目标词元文档频次 dfF（按句去重） */
  const dfF = new Map();
  for (const toks of tgtToks) {
    const seen = new Set();
    for (const t of toks) {
      if (seen.has(t.norm)) continue;
      seen.add(t.norm);
      dfF.set(t.norm, (dfF.get(t.norm) || 0) + 1);
    }
  }

  for (let ci = 0; ci < cands.length; ci++) {
    const c = cands[ci];
    /* 按句聚合出现；术语-目标词元共现 co（按句去重） */
    const occByS = new Map();
    for (const occ of c.occurrences) {
      if (!occByS.has(occ.pair)) occByS.set(occ.pair, []);
      occByS.get(occ.pair).push(occ);
    }
    const dfT = occByS.size;
    const co = new Map();
    for (const [si] of occByS) {
      const seen = new Set();
      for (const t of tgtToks[si]) {
        if (seen.has(t.norm)) continue;
        seen.add(t.norm);
        co.set(t.norm, (co.get(t.norm) || 0) + 1);
      }
    }
    const coNeed = Math.max(1, opts.coGate * dfT);
    /* dfT=1：术语全部出现在同一句，无跨句统计证据，共现门槛坍缩为 1，
     * 句内一切字都"合格"——跳过投票，译文留给 LLM 精筛（SKILL.md 工作流第 2 步）。 */
    if (dfT < 2) {
      c.translations = [];
      c.statConf = 0;
      c.occTotal = c.occurrences.length;
      c.occVoted = 0;
      continue;
    }

    /* 第一轮：每处出现投得分最优 span（同句多出现共享同一最优 span） */
    const chosen = []; // [{pair, span:{lo,hi,phrase}|null}]
    for (const [si, occs] of occByS) {
      const tt = tgtToks[si];
      if (!tt.length) { for (let k = 0; k < occs.length; k++) chosen.push({ pair: si, span: null }); continue; }

      const D = new Map();
      for (const t of tt) {
        if (D.has(t.norm)) continue;
        D.set(t.norm, (2 * (co.get(t.norm) || 0)) / (dfT + (dfF.get(t.norm) || 1)));
      }
      const full = t => (co.get(t.norm) || 0) >= coNeed &&
        D.get(t.norm) >= opts.diceMin && (dfF.get(t.norm) || 0) >= 2;

      const baseline = tgtCJK ? c.n + 1 : Math.ceil(c.n / 2);
      const cap = c.n + opts.slack;
      const scoreSpan = (lo, hi, softIdx) => {
        let s = 0;
        for (let j = lo; j <= hi; j++) if (j !== softIdx) s += D.get(tt[j].norm) || 0;
        return s - opts.widthPenalty * Math.max(0, hi - lo + 1 - baseline);
      };
      let best = null;
      const consider = (lo, hi, softIdx) => {
        if (hi - lo + 1 > cap) return;
        const sc = scoreSpan(lo, hi, softIdx);
        if (!best || sc > best.score + 1e-9) best = { score: sc, lo, hi };
      };

      /* 合格词元连续段：brk 词元可开新段，不可续接（跨度内部不穿子句边界） */
      const runs = [];
      let run = [];
      for (let j = 0; j < tt.length; j++) {
        if (!full(tt[j])) { if (run.length) { runs.push(run); run = []; } continue; }
        if (run.length && tt[j].brk) { runs.push(run); run = [j]; }
        else run.push(j);
      }
      if (run.length) runs.push(run);

      for (const r of runs) {
        const lo0 = r[0], hi0 = r[r.length - 1];
        /* 全部子跨度 */
        for (let lo = lo0; lo <= hi0; lo++) {
          for (let hi = lo; hi <= hi0 && hi - lo + 1 <= cap; hi++) consider(lo, hi, -1);
        }
      }

      if (!best) { for (let k = 0; k < occs.length; k++) chosen.push({ pair: si, span: null }); continue; }
      const phrase = Tok.joinTokens(tt.slice(best.lo, best.hi + 1));
      if (process.env.BTE_DEBUG === c.norm || process.env.BTE_DEBUG === '*') {
        console.error('[vote] cand=' + c.term + ' sent=' + si +
          ' runs=' + JSON.stringify(runs.map(r => r.map(j => tt[j].norm))) +
          ' best=' + JSON.stringify(tt.slice(best.lo, best.hi + 1).map(t => t.norm)) +
          ' score=' + best.score.toFixed(2));
      }
      for (let k = 0; k < occs.length; k++) chosen.push({ pair: si, span: { lo: best.lo, hi: best.hi, phrase } });
    }

    /* 第二轮：共识核改投。核心规则：若第一轮某短语 A 严格包含另一短语 B（如
     * "行机器学习" ⊃ "机器学习"、"模型训练完" ⊃ "模型训练"），则 B 为共识核——
     * 真术语核会在其他出现句中以更纯的形式独立胜出，包含它的粘连带应归顺于它。
     * 无包含关系时不改投（平票互不包含则各自保留，交给 LLM 精筛）。 */
    const pass1 = new Map();
    for (const ch of chosen) {
      if (ch.span && ch.span.phrase) pass1.set(ch.span.phrase, (pass1.get(ch.span.phrase) || 0) + 1);
    }
    let core = null;
    for (const [a, _ca] of pass1) {
      for (const [b, cb] of pass1) {
        if (a === b || a.indexOf(b) < 0) continue;
        if (!core || cb > core.cnt || (cb === core.cnt && b.length < core.phrase.length)) {
          core = { phrase: b, cnt: cb };
        }
      }
    }
    if (!core) {
      let top = null;
      for (const [phrase, cnt] of pass1) {
        if (!top || cnt > top.cnt) top = { phrase, cnt };
      }
      if (top && top.cnt >= 2) core = { phrase: top.phrase, cnt: top.cnt };
    }
    const votes = new Map();
    let total = chosen.length;
    for (const ch of chosen) {
      let phrase = ch.span && ch.span.phrase;
      if (core && phrase && phrase !== core.phrase && phrase.indexOf(core.phrase) >= 0) phrase = core.phrase;
      if (phrase) votes.set(phrase, (votes.get(phrase) || 0) + 1);
    }

    const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    c.translations = sorted.map(([t, v]) => ({ t, votes: v }));
    c.statConf = total ? +((sorted[0] ? sorted[0][1] : 0) / total).toFixed(3) : 0;
    c.occTotal = total;
    c.occVoted = sorted[0] ? sorted[0][1] : 0;
  }
  return cands;
}

module.exports = { voteTranslations, DEFAULTS };

};
factories["./validate.js"]=function(require,module,exports){
'use strict';
/* Bilingual-Term-Extract —— LLM 精筛结果（decisions.json）校验
 * decisions.json 条目：
 *   { "term": "edge computing",   // 必填，须与候选术语精确对应
 *     "accept": true,             // 必填，false = 判定非术语，整条丢弃
 *     "tgt": "边缘计算",           // 可选，确认或修正后的译文；缺省沿用统计最优
 *     "conf": 0.95,               // 可选，0-1
 *     "pos": "noun", "domain": "云计算", "note": "" }  // 可选
 */
const fs = require('fs');
const Tok = require('./tokenizer.js');

function normKey(term) {
  return Tok.keyOf(Tok.tokenize(String(term || '')));
}

function validateDecisions(decisions, candidates) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(decisions)) {
    return { valid: false, errors: ['decisions.json 顶层必须是数组'], warnings };
  }
  const candByTerm = new Map();
  const candByNorm = new Map();
  for (const c of candidates) {
    candByTerm.set(c.term, c);
    candByNorm.set(normKey(c.term), c);
  }
  const seen = new Set();
  decisions.forEach((d, i) => {
    const at = '第 ' + (i + 1) + ' 条';
    if (!d || typeof d !== 'object' || Array.isArray(d)) { errors.push(at + '：不是对象'); return; }
    const term = d.term;
    if (typeof term !== 'string' || !term.trim()) { errors.push(at + '：缺少 term 字段'); return; }
    if (typeof d.accept !== 'boolean') { errors.push(at + '（' + term + '）：accept 必须是布尔值'); }
    if (seen.has(term)) errors.push(at + '（' + term + '）：术语重复出现');
    seen.add(term);
    const hit = candByTerm.get(term) || candByNorm.get(normKey(term));
    if (!hit) {
      errors.push(at + '（' + term + '）：在候选列表中不存在（term 必须与 candidates.json 中的术语一致）');
    }
    if (d.tgt !== undefined && (typeof d.tgt !== 'string')) {
      errors.push(at + '（' + term + '）：tgt 必须是字符串');
    } else if (d.accept === true && (d.tgt === undefined || !String(d.tgt).trim())) {
      warnings.push(at + '（' + term + '）：accept=true 但未给 tgt，将沿用统计最优译文');
    }
    if (d.conf !== undefined && (typeof d.conf !== 'number' || d.conf < 0 || d.conf > 1)) {
      errors.push(at + '（' + term + '）：conf 必须在 0-1 之间');
    }
    for (const k of ['pos', 'domain', 'note']) {
      if (d[k] !== undefined && typeof d[k] !== 'string') errors.push(at + '（' + term + '）：' + k + ' 必须是字符串');
    }
  });
  const decided = new Set();
  for (const d of decisions) if (d && typeof d.term === 'string') decided.add(d.term);
  const normDecided = new Set(decisions.filter(d => d && d.term).map(d => normKey(d.term)));
  let undecided = 0;
  for (const c of candidates) {
    if (!normDecided.has(normKey(c.term))) undecided++;
  }
  return { valid: errors.length === 0, errors, warnings, undecided, total: candidates.length };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.includes('--help')) {
    console.log('用法: node validate.js <decisions.json> <candidates.json>');
    process.exit(args.length < 2 ? 2 : 0);
  }
  let decisions, candJson;
  try {
    decisions = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  } catch (e) { console.error('FATAL: 无法读取/解析 ' + args[0] + '：' + e.message); process.exit(2); }
  try {
    candJson = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  } catch (e) { console.error('FATAL: 无法读取/解析 ' + args[1] + '：' + e.message); process.exit(2); }
  const r = validateDecisions(decisions, candJson.candidates || []);
  for (const w of r.warnings) console.log('WARN: ' + w);
  for (const e of r.errors) console.error('ERROR: ' + e);
  console.log('覆盖：' + (r.total - r.undecided) + '/' + r.total + ' 个候选（未覆盖 ' + r.undecided + ' 个将按统计置信度自动处理）');
  if (!r.valid) { console.error('校验失败'); process.exit(1); }
  console.log('校验通过');
}

if (require.main === module) main();
module.exports = { validateDecisions, normKey };

};
function load(id){if(id==="fs")return {};if(!cache[id]){const m={exports:{}};cache[id]=m;factories[id](load,m,m.exports);}return cache[id].exports;}
const api={...load("./candidates.js"),...load("./vote.js"),...load("./validate.js")};if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.MiniCatTermEngine=api;
})(typeof globalThis!=="undefined"?globalThis:this);
