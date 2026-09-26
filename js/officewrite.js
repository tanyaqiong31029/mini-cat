/* Mini-CAT officewrite.js — minimal .docx / .xlsx WRITERS, zero dependencies.
 * ZIP container uses STORE (no compression) with proper CRC32 — valid OOXML that
 * Word/Excel open directly. Pairs with zip.js/msoffice.js for round-trip tests.
 *
 * buildDocx(blocks)  blocks: {type:'h1'|'p', text, italic?, gray?}
 *                    | {type:'table', header:[], rows:[[]]}
 * buildXlsx(sheets)  sheets: [{name, rows:[[cell,…],…]}]
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.MiniCatWrite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- CRC32 ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- ZIP writer (store) ---------- */
  const TE = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  function utf8(s) { return TE.encode(s); }

  function zipStore(entries) {
    const chunks = [], central = [];
    let offset = 0;
    // fixed DOS timestamp (2026-09-26 12:00) — content-addressed exports don't need real time
    const dosTime = (12 << 11) | (0 << 5) | 0;
    const dosDate = ((2026 - 1980) << 9) | (9 << 5) | 26;
    for (const e of entries) {
      const name = utf8(e.name);
      const data = e.data instanceof Uint8Array ? e.data : utf8(e.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 names
      lv.setUint16(8, 0, true);      // method: store
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, data);
      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cen.set(name, 46);
      central.push(cen);
      offset += local.length + data.length;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    const all = chunks.concat(central, [eocd]);
    let total = 0;
    for (const c of all) total += c.length;
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  /* ---------- XML helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }

  /* ---------- DOCX ---------- */
  function runXml(text, opts) {
    opts = opts || {};
    let rpr = '';
    if (opts.bold) rpr += '<w:b/>';
    if (opts.italic) rpr += '<w:i/>';
    if (opts.gray) rpr += '<w:color w:val="595959"/>';
    if (opts.size) rpr += `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`;
    return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  }
  function pXml(text, opts) {
    return `<w:p>${runXml(text, opts)}</w:p>`;
  }
  function tableXml(header, rows) {
    const cols = Math.max(header.length, ...(rows.length ? rows.map(r => r.length) : [1]));
    let borders = '';
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
      borders += `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`;
    }
    let xml = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>`;
    for (let i = 0; i < cols; i++) xml += '<w:gridCol w:w="2800"/>';
    xml += '</w:tblGrid>';
    const cell = (text, isHead) =>
      `<w:tc><w:tcPr><w:tcW w:w="2800" w:type="dxa"/></w:tcPr>${pXml(text, isHead ? { bold: true, size: 21 } : { size: 21 })}</w:tc>`;
    xml += '<w:tr>' + header.map(h => cell(h, true)).join('') + '</w:tr>';
    for (const r of rows) {
      const cells = [];
      for (let i = 0; i < cols; i++) cells.push(r[i] == null ? '' : r[i]);
      xml += '<w:tr>' + cells.map(c => cell(c, false)).join('') + '</w:tr>';
    }
    xml += '</w:tbl>';
    return xml;
  }

  function buildDocx(blocks) {
    let body = '';
    for (const b of blocks) {
      if (b.type === 'h1') body += pXml(b.text, { bold: true, size: 32 });
      else if (b.type === 'h2') body += pXml(b.text, { bold: true, size: 26 });
      else if (b.type === 'table') body += tableXml(b.header, b.rows);
      else body += pXml(b.text, b);
    }
    const document =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      body +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992"/></w:sectPr>` +
      `</w:body></w:document>`;
    const contentTypes =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`;
    const rels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`;
    return zipStore([
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rels) },
      { name: 'word/document.xml', data: utf8(document) }
    ]);
  }

  /* ---------- XLSX ---------- */
  function colRef(i) {
    let s = '';
    i += 1;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function sheetXml(rows) {
    let xml = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
    rows.forEach((r, ri) => {
      xml += `<row r="${ri + 1}">`;
      r.forEach((c, ci) => {
        const v = c == null ? '' : String(c);
        if (v !== '' && !isNaN(v) && v.trim() !== '') xml += `<c r="${colRef(ci)}${ri + 1}"><v>${esc(v)}</v></c>`;
        else xml += `<c r="${colRef(ci)}${ri + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
      xml += `</row>`;
    });
    xml += `</sheetData></worksheet>`;
    return xml;
  }

  function buildXlsx(sheets) {
    const entries = [];
    let wbSheets = '', wbRels = '', ctOverrides = '';
    sheets.forEach((sh, i) => {
      const id = i + 1;
      wbSheets += `<sheet name="${esc(sh.name).replace(/[\[\]\*\?\/\\:]/g, '_').slice(0, 31)}" sheetId="${id}" r:id="rId${id}"/>`;
      wbRels += `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${id}.xml"/>`;
      ctOverrides += `<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
      entries.push({ name: `xl/worksheets/sheet${id}.xml`, data: utf8(sheetXml(sh.rows)) });
    });
    entries.unshift(
      {
        name: 'xl/workbook.xml',
        data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheets}</sheets></workbook>`)
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels}</Relationships>`)
      },
      {
        name: '[Content_Types].xml',
        data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          ctOverrides + `</Types>`)
      },
      {
        name: '_rels/.rels',
        data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`)
      }
    );
    return zipStore(entries);
  }

  return { crc32, zipStore, buildDocx, buildXlsx, esc };
});
