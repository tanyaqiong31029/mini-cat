/* Mini-CAT style-rules.js — 体例规范打分引擎（依据 Style Sheet V2.6）。
 * 纯规则检查，零依赖；对候选译文逐条给出违规/提示与扣分，聚合为推荐依据。
 * 本模块只做"检查与推荐"，不生成、不改写译文；最终取舍由译者人工决定。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.MiniCatStyleRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- 规则数据（源自 Style Sheet V2.6 §2.1/2.2/2.4/3.2/5/7.3） ---- */

  // §2.1 项目统一英式拼写：美式形式 → 英式建议
  const AMERICAN = {
    'color': 'colour', 'colors': 'colours', 'colored': 'coloured', 'colorful': 'colourful',
    'center': 'centre', 'centers': 'centres', 'centered': 'centred',
    'favor': 'favour', 'favors': 'favours', 'favorable': 'favourable', 'favorite': 'favourite',
    'behavior': 'behaviour', 'behaviors': 'behaviours', 'behavioral': 'behavioural',
    'gray': 'grey', 'grayish': 'greyish',
    'mold': 'mould', 'molds': 'moulds', 'molded': 'moulded', 'molding': 'moulding',
    'enameling': 'enamelling', 'modeled': 'modelled', 'modeling': 'modelling',
    'artifact': 'artefact', 'artifacts': 'artefacts',
    'traveled': 'travelled', 'traveling': 'travelling',
    'defense': 'defence', 'license': 'licence', 'practicing': 'practising'
  };

  // §2.1 -ise/-isation：常见美式 -ize 形式 → 英式建议
  const IZE_MAP = {
    'organize': 'organise', 'organized': 'organised', 'organization': 'organisation',
    'recognize': 'recognise', 'recognized': 'recognised', 'recognizable': 'recognisable',
    'categorize': 'categorise', 'categorized': 'categorised',
    'standardize': 'standardise', 'standardized': 'standardised', 'standardization': 'standardisation',
    'emphasize': 'emphasise', 'emphasized': 'emphasised', 'emphasizing': 'emphasising',
    'specialize': 'specialise', 'specialized': 'specialised', 'specialization': 'specialisation',
    'characterize': 'characterise', 'characterized': 'characterised', 'characteristic': null,
    'summarize': 'summarise', 'summarized': 'summarised',
    'centralize': 'centralise', 'localize': 'localise', 'localized': 'localised',
    'utilize': 'utilise', 'utilized': 'utilised', 'utilization': 'utilisation',
    'analyze': 'analyse', 'analyzed': 'analysed', 'analyzing': 'analysing'
  };

  // §6.2 不得自行增加的评价词（原文不存在的戏剧性/赞叹）
  const BANNED_PRAISE = ['dazzling', 'astonishing', 'breathtaking', 'enchanting', 'revolutionary',
    'magnificent', 'stunning', 'mesmerizing', 'spectacular', 'magical', 'glittering', 'splendid'];

  /* ---- 工具 ---- */
  const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function pushFlag(flags, rule, level, message, weight) {
    flags.push({ rule, level, message, weight });
  }

  /* ---- 各规则：返回 flags 数组 ---- */

  // §2.1 英式拼写（weight 15）
  function checkBritish(text, flags) {
    const lower = ' ' + text.toLowerCase().replace(/[^a-z'-]+/g, ' ') + ' ';
    for (const [am, br] of Object.entries(AMERICAN)) {
      const re = new RegExp('(^|[^a-z-])' + escapeRe(am) + '([^a-z-]|$)', 'i');
      if (re.test(lower)) {
        pushFlag(flags, 'spelling', '违规', `美式拼写 ${am} → 应为 ${br}（British English）`, 15);
      }
    }
  }

  // §2.1 -ise/-isation（weight 8）
  function checkIze(text, flags) {
    for (const [am, br] of Object.entries(IZE_MAP)) {
      if (br === null) continue;
      const re = new RegExp('\\b' + escapeRe(am) + '\\b', 'i');
      if (re.test(text)) {
        pushFlag(flags, 'spelling', '违规', `${am} → 应为 ${br}（项目统一 -ise/-isation）`, 8);
      }
    }
  }

  // §2.2/3.1 年代范围用 en dash；BCE/CE；decade 无撇号（合计 weight 12）
  function checkNumbers(text, flags) {
    const hyphenRange = text.match(/\b(1\d{3}|20\d{2})\s*-\s*(1\d{3}|20\d{2})\b/);
    if (hyphenRange) {
      pushFlag(flags, 'numbers', '违规', `年代范围应使用 en dash：${hyphenRange[0].replace('-', '–')}（不用连字符 -）`, 6);
    }
    if (/\b(19|20)\d0's\b/.test(text)) {
      pushFlag(flags, 'numbers', '违规', '年代十位写法应为 1930s / 1970s（不加所有格撇号）', 4);
    }
    if (/\b\d+\s?(BC|B\.C\.|AD|A\.D\.)\b/.test(text)) {
      pushFlag(flags, 'numbers', '违规', '公元体系应统一为 BCE / CE', 4);
    }
    if (/\d\s+%/.test(text)) {
      pushFlag(flags, 'numbers', '违规', '百分数数字与 % 之间不留空格（30%）', 3);
    }
    const hasPercentWord = /\bper ?cent\b|\bpercent\b/i.test(text);
    if (hasPercentWord && /\d\s?%/.test(text)) {
      pushFlag(flags, 'numbers', '提示', '同一数据组不得在 percent / per cent / % 之间切换', 2);
    }
    const tight = text.match(/\b\d+(cm|mm|kg|g|°C|ml)\b/);
    if (tight) {
      pushFlag(flags, 'numbers', '违规', `数值与单位之间留一空格：${tight[0]} → ${tight[0].replace(/(cm|mm|kg|g|°C|ml)$/, ' $1')}`, 5);
    }
  }

  // §6.2 不得自行增加评价词（weight 10）
  function checkPraise(text, flags) {
    for (const w of BANNED_PRAISE) {
      const re = new RegExp('\\b' + escapeRe(w) + '\\b', 'i');
      if (re.test(text)) {
        pushFlag(flags, 'praise', '违规', `疑似自行增加的评价词 ${w}（原文不存在的戏剧性表达）`, 10);
      }
    }
  }

  // §5 证据强度（info，weight 4）
  function checkEvidence(text, flags) {
    const re = /\bprove[sd]?\b|\bproof\b|\bdefinitely\b|\bundeniably\b/i;
    if (re.test(text)) {
      pushFlag(flags, 'evidence', '提示', '证据强度层级：考古/断代语境优先区分 观察→表明/支持→证明；确认原文确为"证明"再保留', 4);
    }
  }

  // §3.2 中文字符（info，weight 4）
  function checkCJK(text, flags) {
    if (CJK.test(text)) {
      pushFlag(flags, 'pinyin', '提示', '正文中含中文字符——仅在辨析同音异字/铭文等确有必要时保留', 4);
    }
  }

  // §7.3 图注模板（仅当源文像图注时，weight 6）
  function checkCaption(source, text, flags) {
    const m = source.match(/^\s*图\s*(\d+)/);
    if (!m) return;
    const n = m[1];
    if (!new RegExp('^\\s*Fig\\.?\\s*' + n + '\\b').test(text)) {
      pushFlag(flags, 'caption', '违规', `图注应以 Fig. ${n} 开头（模板：Fig. X. [Period]. [Object name]…）`, 6);
    }
    if (/[.。]$/.test(text.trim()) && !/\b[A-Z]\.$/.test(text.trim())) {
      pushFlag(flags, 'caption', '提示', '图注末尾不加句末标点（Fig. 中的缩写点保留）', 2);
    }
  }

  // §8.1 术语表一致性（weight 最高：每处缺失扣 12）
  function checkTermbase(source, text, terms, flags) {
    const lower = text.toLowerCase();
    const seen = new Set();
    for (const t of terms || []) {
      if (!t.zh || !t.en) continue;
      if (!source.includes(t.zh)) continue;
      const key = t.zh + '→' + t.en;
      if (seen.has(key)) continue;
      seen.add(key);
      const en = t.en.trim();
      if (!en) continue;
      // 容差：术语英文不区分大小写地包含即可；多词术语按整串查
      const re = new RegExp(escapeRe(en).replace(/\s+/g, '\\s+'), 'i');
      if (!re.test(text)) {
        pushFlag(flags, 'termbase', '违规', `术语「${t.zh}」应使用术语表译法 ${en}`, 12);
      }
    }
  }

  /* ---- 聚合 ---- */

  /* evaluate(source, candidate, terms) →
   * { score, flags:[{rule,level,message,weight}], passed } */
  function evaluate(source, candidate, terms) {
    const flags = [];
    if (!candidate || !candidate.trim()) return { score: 0, flags, passed: false };
    checkTermbase(source, candidate, terms, flags);
    checkBritish(candidate, flags);
    checkIze(candidate, flags);
    checkNumbers(candidate, flags);
    checkPraise(candidate, flags);
    checkEvidence(candidate, flags);
    checkCJK(candidate, flags);
    checkCaption(source, candidate, flags);
    let score = 100;
    for (const f of flags) score -= f.weight;
    score = Math.max(0, score);
    return { score, flags, passed: flags.every(f => f.level === '提示') };
  }

  /* 对同一句的多个候选评分并排序（稳定：同分保持导入顺序） */
  function rank(candidates, source, terms) {
    const scored = candidates.map(c => {
      const r = evaluate(source, c.text, terms);
      return Object.assign({}, c, { score: r.score, flags: r.flags, passed: r.passed });
    });
    scored.forEach((c, i) => { c.order = i; });
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored;
  }

  return { evaluate, rank, AMERICAN, IZE_MAP, BANNED_PRAISE, BACKUP: null };
});
