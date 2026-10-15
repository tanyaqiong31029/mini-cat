/* Node tests for io.js: bilingual header auto-mapping and TMX inline-markup stripping. */
const { DOMParser } = require('linkedom');
global.DOMParser = DOMParser; // io.js 的 TMX 解析依赖 DOMParser（运行时用浏览器自带；测试注入 linkedom）
const IO = require('../js/io.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

/* --- header mapping: whole-token, priority, no column reuse --- */
let m = IO.mapBilingualHeader(['Segment', '中文', 'English']);
ok(m.src === 1 && m.tgt === 2, `'en' must not hit "Segment" (got ${JSON.stringify(m)})`);
m = IO.mapBilingualHeader(['Sentence ID', 'Source', 'Target']);
ok(m.id === 0 && m.src === 1 && m.tgt === 2, `Sentence ID/Source/Target (got ${JSON.stringify(m)})`);
m = IO.mapBilingualHeader(['Content', 'zh', 'en']);
ok(m.src === 1 && m.tgt === 2, `'en' must not hit "Content" (got ${JSON.stringify(m)})`);
m = IO.mapBilingualHeader(['Source ID', 'Source', 'Target', 'Notes']);
ok(m.id === 0 && m.src === 1 && m.tgt === 2 && m.note === 3, `Source ID not reused as src (got ${JSON.stringify(m)})`);
m = IO.mapBilingualHeader(['术语ID', '中文术语', '2026最终译法', '语境/定义']);
ok(m.id === 0 && m.src === 1 && m.tgt === 2 && m.note === 3, `CJK headers keep substring matching (got ${JSON.stringify(m)})`);
m = IO.mapBilingualHeader(['zh-CN', 'en-US']);
ok(m.src === 0 && m.tgt === 1, `locale-code headers (got ${JSON.stringify(m)})`);
m = IO.mapBilingualHeader(['Sentence', 'Comment']);
ok(m.src === -1 && m.tgt === -1, `no false positives (got ${JSON.stringify(m)})`);

/* --- TMX: inline bpt/ept/it/ph contents are not text --- */
const tmx = `<?xml version="1.0" encoding="UTF-8"?>
<tmx version="1.4"><header srclang="zh-CN" datatype="plaintext"/><body>
<tu tuid="7"><tuv xml:lang="zh-CN"><seg><bpt i="1">&lt;b&gt;</bpt>青花<ept i="1">&lt;/b&gt;</ept>瓷<ph x="1">{1}</ph></seg></tuv>
<tuv xml:lang="en-US"><seg><it pos="begin">&lt;i&gt;</it>blue-and-<hi>white</hi> porcelain</seg></tuv></tu>
<tu tuid="8"><tuv xml:lang="zh-CN"><seg>釉</seg></tuv><tuv xml:lang="en-US"><seg>glaze</seg></tuv></tu>
</body></tmx>`;
const parsed = IO.parseTMX(tmx);
ok(parsed.tus.length === 2, `two TUs (got ${parsed.tus.length})`);
ok(parsed.tus[0].src === '青花瓷', `inline codes stripped from src (got ${JSON.stringify(parsed.tus[0].src)})`);
ok(parsed.tus[0].tgt === 'blue-and-white porcelain', `<hi> text kept, <it> dropped (got ${JSON.stringify(parsed.tus[0].tgt)})`);
ok(parsed.tus[1].src === '釉' && parsed.tus[1].tgt === 'glaze', 'plain TU unchanged');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
