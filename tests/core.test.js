/* Node tests for js/core.js — run: node tests/core.test.js */
const Core = require('../js/core.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

/* --- normalization --- */
ok(Core.normalize('  Hello　World！ ') === 'hello world!', 'normalize width+case+space');
ok(Core.normalizeCJK('青 花 瓷') === '青花瓷', 'normalizeCJK drops spaces');

/* --- similarity --- */
const s1 = '青花瓷是景德镇窑的代表性产品。';
ok(Core.matchScore(s1, s1) === 100, 'exact match = 100');
ok(Core.matchScore(s1, '青花瓷是景德镇窑的代表性产品') >= 95, 'punct-only diff ≥ 95');
const s2 = '青花瓷是景德镇窑最有代表性的产品之一。';
const sc = Core.matchScore(s1, s2);
ok(sc >= 70 && sc < 100, `near-duplicate fuzzy in band (got ${sc})`);
ok(Core.matchScore('龙泉窑以青釉著称。', ' totally unrelated english text about coffee') < 20, 'unrelated low');
ok(Core.matchScore('短。', '完全不同的一段较长的中文内容，与前面没有任何相似之处。') === 0, 'length gate kills short vs long');

/* --- index & findMatches --- */
const tm = [
  { id: 1, src: '青花瓷是景德镇窑的代表性产品。', srcNorm: Core.normalizeCJK('青花瓷是景德镇窑的代表性产品。'), grams: [...Core.bigrams('青花瓷是景德镇窑的代表性产品。')], tgt: 'Blue-and-white porcelain is representative of the Jingdezhen kilns.' },
  { id: 2, src: '宋代五大名窑各有风格。', srcNorm: Core.normalizeCJK('宋代五大名窑各有风格。'), grams: [...Core.bigrams('宋代五大名窑各有风格。')], tgt: 'The five great Song kilns each have their own style.' },
  { id: 3, src: '釉里红以铜为呈色剂。', srcNorm: Core.normalizeCJK('釉里红以铜为呈色剂。'), grams: [...Core.bigrams('釉里红以铜为呈色剂。')], tgt: 'Underglaze red uses copper as the colorant.' }
];
const idx = Core.createTMIndex(tm);
const hits = Core.findMatches('青花瓷是景德镇窑的代表性产品之一。', tm, idx, 50, 5);
ok(hits.length >= 1 && hits[0].entry.id === 1 && hits[0].score >= 70, `index finds right candidate (top=${hits[0] && hits[0].entry.id}, score=${hits[0] && hits[0].score})`);
const hitsExact = Core.findMatches('宋代五大名窑各有风格。', tm, idx, 50, 5);
ok(hitsExact[0].score === 100, 'exact through index path');

/* --- segmentation --- */
const paras = '这是第一句。这是第二句！短。然后第三句；最后一个问题？';
const segs = Core.segmentText(paras, 6);
ok(segs.length === 5, `sentence split keeps delimiters (got ${segs.length}: ${JSON.stringify(segs)})`);
ok(Core.segmentText('小。句。', 6).length === 1, 'short sentences merge');
ok(Core.segmentText('Price is 3.5 yuan. OK.', 2).length === 2, 'decimal not split');
ok(Core.segmentText('第一段。\n第二段。').length === 2, 'paragraph boundary');

/* --- terms --- */
const terms = [
  { id: 1, zh: '青花瓷', en: 'blue-and-white porcelain' },
  { id: 2, zh: '景德镇窑', en: 'Jingdezhen kilns' },
  { id: 3, zh: '釉', en: 'glaze' }
];
const text = '青花瓷是景德镇窑的代表，釉色稳定。';
const hitsT = Core.findTerms(text, terms);
ok(hitsT.length === 3, `three term hits (got ${hitsT.length})`);
ok(hitsT[0].term.zh === '青花瓷' && hitsT[0].start === 0, 'longest-first greedy, correct positions');
ok(hitsT[2].term.zh === '釉' && hitsT[2].start === 12, `single char term hit (start=${hitsT[2].start})`);

/* --- TMX round trip (io.js needs DOMParser — test build only for escaping here) --- */
ok(Core.escapeHtml('<b>&"') === '&lt;b&gt;&amp;&quot;', 'escapeHtml');

/* --- CSV parsing (io.js, pure functions) --- */
const IO = require('../js/io.js');
const csvText = '\uFEFF术语ID,中文术语,2026最终译法,语境/定义\r\nTB-0001,青釉褐彩瓷器,"celadon ware, brown decor","含,逗号的定义"\r\nTB-0002,彩绘瓷,painted porcelain,\r\n';
const table = IO.sniffBilingualTable(csvText);
ok(table && table.header.length === 4, `sniff: header 4 cols (got ${table && table.header.length})`);
ok(table.header[1] === '中文术语', 'sniff: BOM stripped');
ok(table.rows.length === 2, `sniff: 2 rows (got ${table.rows.length})`);
ok(table.rows[0][2] === 'celadon ware, brown decor', 'sniff: quoted comma preserved');
ok(table.rows[0][3] === '含,逗号的定义', 'sniff: CJK quoted comma preserved');
ok(table.mapping.src === 1 && table.mapping.tgt === 2, 'sniff: auto column mapping');
const tsv = IO.sniffBilingualTable('中文\t英文\n青瓷\tceladon');
ok(tsv.mapping.src === 0 && tsv.rows[0][1] === 'celadon', 'sniff: TSV auto-detect');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
