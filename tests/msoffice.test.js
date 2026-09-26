/* Node tests for zip.js on real .xlsx/.docx fixtures + core ICE matching.
 * (msoffice.js XML layer needs DOMParser — verified in the browser; zip layer is DOM-free.) */
const fs = require('fs');
const path = require('path');
const Zip = require('../js/zip.js');
const Core = require('../js/core.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

(async () => {
  /* --- zip: list + extract on xlsx --- */
  const xlsx = fs.readFileSync(path.join(__dirname, 'fixtures/sample_terms.xlsx'));
  const names = await Zip.list(xlsx);
  ok(names.includes('xl/workbook.xml'), 'xlsx: workbook entry present');
  
  ok(names.some(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)), 'xlsx: worksheet present');
  const wb = await Zip.extractText(xlsx, 'xl/workbook.xml');
  ok(wb.includes('示例术语表'), 'xlsx: sheet name readable');
  // openpyxl writes inlineStr (no sharedStrings) — both layouts must work; XML layer verified in browser
  const sheetXml = await Zip.extractText(xlsx, 'xl/worksheets/sheet1.xml');
  ok(sheetXml.includes('t="inlineStr"'), 'xlsx: inlineStr cells readable');

  /* --- zip: deflate-raw on docx --- */
  const docx = fs.readFileSync(path.join(__dirname, 'fixtures/sample_bilingual.docx'));
  const dnames = await Zip.list(docx);
  ok(dnames.includes('word/document.xml'), 'docx: document.xml present');
  const doc = await Zip.extractText(docx, 'word/document.xml');
  ok(doc.includes('青花瓷是代表性产品。'), 'docx: Chinese cell text extracts');
  ok(doc.includes('Blue-and-white porcelain'), 'docx: English cell text extracts');
  ok(doc.includes('单独的中文段落'), 'docx: standalone paragraph extracts');

  /* --- zip: error paths --- */
  try { await Zip.extract(xlsx, 'xl/nope.xml'); ok(false, 'zip: missing entry should throw'); }
  catch (e) { ok(/缺少条目/.test(e.message), 'zip: missing entry throws'); }
  try { await Zip.readCentralDirectory(Buffer.from('not a zip')); ok(false, 'zip: non-zip should throw'); }
  catch (e) { ok(/EOCD/.test(e.message), 'zip: non-zip throws'); }

  /* --- core: ICE 101 matching --- */
  const A = '青花瓷是景德镇窑的代表性产品。';
  const B = '其釉色如雨过天青。';
  const tm = [
    { id: 1, src: A, srcNorm: Core.normalizeCJK(A), grams: [...Core.bigrams(A)], tgt: 'T-A', prevNorm: '' },
    { id: 2, src: B, srcNorm: Core.normalizeCJK(B), grams: [...Core.bigrams(B)], tgt: 'T-B', prevNorm: Core.normalizeCJK(A) },
    { id: 3, src: '完全不同的一句话，讲的是别的事情。', srcNorm: Core.normalizeCJK('完全不同的一句话，讲的是别的事情。'), grams: [...Core.bigrams('完全不同的一句话，讲的是别的事情。')], tgt: 'T-C', prevNorm: '' }
  ];
  const idx = Core.createTMIndex(tm);
  const hits1 = Core.findMatches(A, tm, idx, 50, 5, '');
  ok(hits1[0].score === 100, 'first segment: plain exact (no prev context)');
  const hits2 = Core.findMatches(B, tm, idx, 50, 5, Core.normalizeCJK(A));
  ok(hits2[0].score === 101, 'second segment: ICE 101 when prev matches');
  ok(Core.matchBand(101).key === 'ice' && Core.matchBand(101).label === '101% ICE', 'band: 101 labelled ICE');
  const hits3 = Core.findMatches(B, tm, idx, 50, 5, Core.normalizeCJK('别的上文。'));
  ok(hits3[0].score === 100, 'same target without context stays 100');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
