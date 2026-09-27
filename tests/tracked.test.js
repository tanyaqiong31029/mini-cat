/* Node tests: Word 修订模式（w:ins/w:del）与批注的自动识别。
 * 构造携带修订标记的合成 docx → docxToBlocks 解析 → 断言自动提取的作者/日期/新旧文本/批注/文件属性。 */
const Write = require('../js/officewrite.js');
const Zip = require('../js/zip.js');
const Office = require('../js/msoffice.js');
const { DOMParser } = require('linkedom');
Office.setXmlParser(DOMParser); // Node 测试环境注入 XML 解析器（运行时零依赖不变）

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:tbl>
  <w:tr>
    <w:tc><w:p><w:r><w:t>青釉</w:t></w:r></w:p></w:tc>
    <w:tc><w:p>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:t>celadon</w:t></w:r>
      <w:del w:id="1" w:author="刘小婷" w:date="2026-09-26T10:00:00Z"><w:r><w:delText> glaze</w:delText></w:r></w:del>
      <w:ins w:id="2" w:author="刘小婷" w:date="2026-09-26T10:00:00Z"><w:r><w:t>-green glaze</w:t></w:r></w:ins>
      <w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>
    </w:p></w:tc>
  </w:tr>
  <w:tr>
    <w:tc><w:p><w:r><w:t>窑具</w:t></w:r></w:p></w:tc>
    <w:tc><w:p><w:r><w:t>kiln furniture</w:t></w:r></w:p></w:tc>
  </w:tr>
</w:tbl>
<w:p><w:r><w:t>尾段。</w:t></w:r></w:p>
</w:body></w:document>`;

const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>谭雅琼</dc:creator><cp:lastModifiedBy>刘小婷</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-26T08:00:00Z</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">2026-09-26T10:00:00Z</dcterms:modified>
</cp:coreProperties>`;

const commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:comment w:id="0" w:author="李华东" w:date="2026-09-26T11:00:00Z" w:initials="李"><w:p><w:r><w:t>此处建议核对 Termbase 中青釉的规范译法。</w:t></w:r></w:p></w:comment>
</w:comments>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const pkgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="word/comments.xml"/>
</Relationships>`;

(async () => {
  const buf = Write.zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: pkgRels },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/comments.xml', data: commentsXml },
    { name: 'docProps/core.xml', data: coreXml }
  ]);

  const parsed = await Office.docxToBlocks(buf);

  /* 表格最终文本：含 w:ins，排除 w:delText */
  ok(parsed.tables.length === 1 && parsed.tables[0].rows.length === 2, 'tracked docx: table extracted');
  const enCell = parsed.tables[0].rows[0][1];
  ok(enCell.includes('-green glaze') && !enCell.includes(' glaze') === false, `final text keeps ins (got: ${enCell})`);
  ok(parsed.tables[0].rows[1][1] === 'kiln furniture', 'untouched row intact');

  /* 修订记录自动识别：作者/日期/新旧文本 */
  const trk = parsed.tables[0].rowTracked;
  ok(Array.isArray(trk) && trk.length === 1, `rowTracked extracted (got ${trk && trk.length})`);
  ok(trk[0].author === '刘小婷', `author auto-detected (got ${trk[0].author})`);
  ok(trk[0].date === '2026-09-26T10:00:00Z', 'date auto-detected');
  ok(trk[0].original.includes('celadon') && trk[0].original.includes(' glaze'), 'original (pre-revision) text reconstructed');
  ok(trk[0].final.includes('-green glaze'), 'final (post-revision) text');

  /* Word 批注自动识别：作者/日期/内容/锚点行 */
  ok(parsed.comments.length === 1, 'comments part parsed');
  ok(parsed.comments[0].author === '李华东' && parsed.comments[0].text.includes('Termbase'), 'comment author + text');
  const rc = parsed.tables[0].rowComments;
  ok(rc.length === 1 && rc[0].ids.includes('0') && rc[0].row === 0, 'comment anchored to correct row');

  /* 文件属性：最后修改人/时间 */
  ok(parsed.meta.lastModifiedBy === '刘小婷', `meta.lastModifiedBy (got ${parsed.meta.lastModifiedBy})`);
  ok(String(parsed.meta.modified).includes('2026-09-26'), 'meta.modified');

  /* 段落（表外）不受影响 */
  ok(parsed.paragraphs.some(p => p === '尾段。'), 'body paragraph extracted');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
