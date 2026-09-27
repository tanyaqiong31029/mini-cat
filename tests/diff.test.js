/* Node tests for diff.js + tracked-changes/comments docx generation. */
const Diff = require('../js/diff.js');
const Write = require('../js/officewrite.js');
const Zip = require('../js/zip.js');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

/* --- diffWords --- */
const ops = Diff.diffWords('The vase shows a celadon glaze with fine crackle.', 'The vase shows a pale celadon glaze with fine crackle.');
ok(ops.some(o => o.t === 'ins' && o.text.includes('pale')), 'ins detected for inserted word');
ok(!ops.some(o => o.t === 'del'), 'no del for pure insertion');
const ops2 = Diff.diffWords('the vessel was fired in the Song dynasty', 'the vessel was fired during the Song dynasty');
ok(ops2.some(o => o.t === 'ins' && o.text === 'during'), 'mid-sentence insertion');
const ops3 = Diff.diffWords('identical text here', 'identical text here');
ok(ops3.length === 1 && ops3[0].t === 'eq', 'identical → single eq op');
ok(Diff.sameText('  A  B ', 'A B'), 'sameText whitespace-normalized');
const st = Diff.diffStats(ops);
ok(st.changed && st.ins >= 1, 'diffStats counts insertions');

/* --- tracked changes + comments in docx --- */
const trkOps = Diff.diffWords('old translation text here', 'new translation text here');
const comments = [
  { id: 0, author: '刘小婷', date: '2026-09-27T10:00:00Z', initials: '刘', text: '此处术语与 Termbase 不一致，请核对。' }
];
const blocks = [
  { type: 'h1', text: '修订痕迹' },
  { type: 'p', text: '中文原文：青花瓷是景德镇窑的代表性产品。', comments: [0] },
  { type: 'trk', ops: trkOps, author: '刘小婷', date: '2026-09-27T10:00:00Z' }
];
const docx = Write.buildDocx(blocks, { comments });
fs.writeFileSync(path.join(__dirname, 'fixtures/_trk.docx'), docx);
const names = Zip.list ? null : null;
(async () => {
  const entries = await Zip.list(docx);
  ok(entries.includes('word/comments.xml'), 'tracked docx: comments part present');
  ok(entries.includes('word/_rels/document.xml.rels'), 'tracked docx: document rels present');
  const doc = await Zip.extractText(docx, 'word/document.xml');
  ok(doc.includes('<w:del ') && doc.includes('<w:delText'), 'docx: w:del with delText');
  ok(doc.includes('<w:ins ') && doc.includes('w:author="刘小婷"'), 'docx: w:ins with author');
  ok(doc.includes('w:commentRangeStart') && doc.includes('w:commentReference'), 'docx: comment anchors');
  const cXml = await Zip.extractText(docx, 'word/comments.xml');
  ok(cXml.includes('Termbase') || cXml.includes('术语'), 'comments.xml: comment text present');
  ok(/<w:ins [^>]*><w:r><w:t[^>]*>new <\/w:t>/.test(doc), 'docx: ins run with new word');
  // 修订后的最终文本 = eq+ins（delText 不计入 w:t）
  const wtCount = (doc.match(/<w:t /g) || []).length;
  ok(wtCount >= 2, 'docx: visible runs present');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
