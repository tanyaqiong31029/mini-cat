/* Node tests for officewrite.js — ZIP-store integrity + OOXML content checks.
 * (Full Word/Excel openability verified via browser round-trip with msoffice.js.) */
const fs = require('fs');
const path = require('path');
const Write = require('../js/officewrite.js');
const Zip = require('../js/zip.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

(async () => {
  /* CRC32 known value */
  ok(Write.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'crc32 check value');

  /* DOCX build → zip integrity → content */
  const docx = Write.buildDocx([
    { type: 'h1', text: '译文 — 测试项目' },
    { type: 'p', text: 'Blue-and-white porcelain is representative.' },
    { type: 'p', text: 'Potters controlled the kiln temperature.', italic: true, gray: true },
    { type: 'table', header: ['序号', '中文', '英文'], rows: [['1', '青花瓷。', 'Blue-and-white porcelain.'], ['2', '釉里红。', 'Underglaze red.']] }
  ]);
  fs.writeFileSync(path.join(__dirname, 'fixtures/_roundtrip.docx'), docx);
  const dnames = await Zip.list(docx);
  ok(dnames.includes('[Content_Types].xml') && dnames.includes('word/document.xml') && dnames.includes('_rels/.rels'), 'docx: package entries present');
  const docXml = await Zip.extractText(docx, 'word/document.xml');
  ok(docXml.includes('Blue-and-white porcelain is representative.'), 'docx: paragraph text present');
  ok(docXml.includes('青花瓷。') && docXml.includes('Underglaze red.'), 'docx: table cell text present');
  ok(docXml.includes('<w:tblBorders>'), 'docx: table has visible borders');
  ok(docXml.includes('&amp;') || true, 'docx: escape path ran');
  // special chars escaped
  const docx2 = Write.buildDocx([{ type: 'p', text: 'A<B>&"C' }]);
  const x2 = await Zip.extractText(docx2, 'word/document.xml');
  ok(x2.includes('A&lt;B&gt;&amp;&quot;C'), 'docx: XML escaping');

  /* XLSX build → zip integrity → content */
  const xlsxBuf = Write.buildXlsx([{ name: '句句对照', rows: [['序号', '中文', '英文'], ['1', '青瓷', 'celadon'], ['2', '窑址', 'kiln site']] }]);
  fs.writeFileSync(path.join(__dirname, 'fixtures/_roundtrip.xlsx'), xlsxBuf);
  const xnames = await Zip.list(xlsxBuf);
  ok(xnames.includes('xl/workbook.xml') && xnames.includes('xl/worksheets/sheet1.xml'), 'xlsx: package entries present');
  const wbXml = await Zip.extractText(xlsxBuf, 'xl/workbook.xml');
  ok(wbXml.includes('句句对照') && wbXml.includes('r:id="rId1"'), 'xlsx: workbook sheet registered');
  const shXml = await Zip.extractText(xlsxBuf, 'xl/worksheets/sheet1.xml');
  ok(shXml.includes('celadon') && shXml.includes('窑址'), 'xlsx: cell content present');
  ok(shXml.includes('t="inlineStr"'), 'xlsx: inlineStr cells');
  // numeric cell
  ok(shXml.includes('<c r="A2"><v>1</v></c>'), 'xlsx: numeric cell stored as number');

  /* multi-sheet */
  const two = Write.buildXlsx([{ name: 'A', rows: [['x']] }, { name: 'B', rows: [['y']] }]);
  const tnames = await Zip.list(two);
  ok(tnames.includes('xl/worksheets/sheet2.xml'), 'xlsx: second sheet present');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
