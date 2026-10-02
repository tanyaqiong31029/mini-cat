/* Node tests: style-rules.js — Style Sheet V2.6 规则引擎 */
const SR = require('../js/style-rules.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}
const flat = flags => flags.map(f => f.rule + ':' + f.message).join(' || ');

/* §2.1 英式拼写 */
let r = SR.evaluate('The color of the center is striking.', 'The color of the center is striking.', []);
ok(r.flags.some(f => f.message.includes('color') && f.message.includes('colour')), 'British: color → colour');
ok(r.flags.some(f => f.message.includes('center')), 'British: center → centre');
ok(r.score <= 85, `British deduction applied (score ${r.score})`);
r = SR.evaluate('The colour of the centre is striking.', 'The colour of the centre is striking.', []);
ok(!r.flags.some(f => f.rule === 'spelling'), 'British: correct spelling passes');

/* §2.1 -ise/-isation */
r = SR.evaluate('Scholars organize the kilns by period and standardize the typology.', 'Scholars organize the kilns by period and standardize the typology.', []);
ok(r.flags.some(f => f.message.includes('organise')), 'ise: organize → organise');
ok(r.flags.some(f => f.message.includes('standardise')), 'ise: standardize → standardise');
r = SR.evaluate('They organise and standardize the record.', 'They organise and standardize the record.', []);
ok(!r.flags.some(f => f.message.includes('organis') && f.message.includes('organize')), 'ise: correct forms pass');

/* 灰/模具/器物拼写 */
r = SR.evaluate('A grayish mold with an enameling kiln and one artifact.', 'A grayish mold with an enameling kiln and one artifact.', []);
['grayish', 'mold', 'enameling', 'artifact'].forEach(w => ok(
  r.flags.some(f => f.message.includes(w)), 'British: ' + w
));

/* §2.2/3.1 数字年代 */
r = SR.evaluate('The kiln dates to 1106-1110, unlike the 1930\u2019s labels.', 'The kiln dates to 1106-1110, unlike the 1930\u2019s labels.', []);
  r = SR.evaluate('The 1930\u2019s labels.', 'The 1930\u2019s labels.', []);
ok(!r.flags.some(f => f.rule === 'numbers' && f.level === '\u8fdd\u89c4'), 'numbers: correct forms pass');
r = SR.evaluate('The tomb dates from 500 BC.', 'The tomb dates from 500 BC.', []);
ok(r.flags.some(f => f.message.includes('BCE')), 'numbers: BC → BCE');
r = SR.evaluate('The vessel is 15cm tall and fired at 1,200 °C with 30 % gloss.', 'The vessel is 15cm tall and fired at 1,200 °C with 30 % gloss.', []);
ok(r.flags.some(f => f.message.includes('15 cm')), 'numbers: unit spacing');
ok(r.flags.some(f => f.message.includes('%')), 'numbers: percent spacing');
r = SR.evaluate('About 30% of the sherds; measured 15 cm tall.', 'About 30% of the sherds; measured 15 cm tall.', []);
ok(!r.flags.some(f => f.rule === 'numbers' && f.level === '违规'), 'numbers: 30% and 15 cm pass');

/* §6.2 评价词 */
r = SR.evaluate('A dazzling array of dazzling wares — simply enchanting.', 'A dazzling array of dazzling wares — simply enchanting.', []);
ok(r.flags.filter(f => f.rule === 'praise').length >= 2, 'praise: banned words flagged');

/* §5 证据强度 */
r = SR.evaluate('This proves the kiln existed.', 'This proves the kiln existed.', []);
ok(r.flags.some(f => f.rule === 'evidence'), 'evidence: prove flagged as 提示');

/* §3.2 中文字符 */
r = SR.evaluate('The term 胎釉 appears here.', 'The term 胎釉 appears here.', []);
ok(r.flags.some(f => f.rule === 'pinyin'), 'pinyin: CJK chars flagged 提示');

/* §7.3 图注 */
r = SR.evaluate('图29 北宋 汝窑水仙盆', 'Plate 29. Northern Song. Ru washer.');
ok(r.flags.some(f => f.rule === 'caption' && f.message.includes('Fig. 29')), 'caption: Fig. X template');
r = SR.evaluate('图29 北宋 汝窑水仙盆', 'Fig. 29. Northern Song. Ru washer, Palace Museum');
ok(!r.flags.some(f => f.rule === 'caption' && f.level === '违规'), 'caption: correct template passes');

/* §8.1 术语表一致性 */
const terms = [
  { zh: '青花瓷', en: 'blue-and-white porcelain' },
  { zh: '釉里红', en: 'underglaze red' }
];
r = SR.evaluate('青花瓷与釉里红并存。', 'Cobalt-blue ware and underglaze red coexist.', terms);
ok(r.flags.some(f => f.rule === 'termbase' && f.message.includes('blue-and-white porcelain')), 'termbase: missing term flagged');
r = SR.evaluate('青花瓷与釉里红并存。', 'Blue-and-white porcelain coexists with underglaze red.', terms);
ok(!r.flags.some(f => f.rule === 'termbase'), 'termbase: matching translation passes');
r = SR.evaluate(' unrelated english only. ', 'Nothing relevant here.', terms);
ok(!r.flags.some(f => f.rule === 'termbase'), 'termbase: no zh term in source → no check');

/* 排序：推荐 = 最高分 */
const ranked = SR.rank([
  { model: 'A', text: 'The color of the center…' },
  { model: 'B', text: 'The colour of the centre…' }
], '中心的釉色很美。', []);
ok(ranked[0].model === 'B' && ranked[0].score >= ranked[1].score, 'rank: better candidate first');
ok(ranked[0].score > ranked[1].score, 'rank: score gap visible');

/* 空候选 */
r = SR.evaluate('原文', '', []);
ok(r.score === 0 && !r.passed, 'empty candidate scores 0');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
