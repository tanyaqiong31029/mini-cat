/* Mini-CAT msoffice.js — .xlsx and .docx text extraction, zero dependencies.
 * Containers are unpacked with zip.js; the XML inside is parsed with DOMParser
 * (browser) — the only browser-only dependency in the I/O layer.
 *
 *  xlsxToSheets(buf) → [{name, rows:[[cell,…],…]}]   strings via sharedStrings, inlineStr, numbers
 *  docxToBlocks(buf) → {paragraphs:[text,…], tables:[{header:[…], rows:[[…],…]}]}
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./zip.js'));
  else root.MiniCatOffice = factory(root.MiniCatZip);
})(typeof self !== 'undefined' ? self : this, function (Zip) {
  'use strict';

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Office XML 解析失败');
    return doc;
  }

  /* ---------- xlsx ---------- */

  function colToIndex(ref) {
    // "BC12" → 54
    let n = 0, sawLetter = false;
    for (const ch of ref) {
      if (ch >= 'A' && ch <= 'Z') { n = n * 26 + (ch.charCodeAt(0) - 64); sawLetter = true; }
      else if (ch >= 'a' && ch <= 'z') { n = n * 26 + (ch.charCodeAt(0) - 96); sawLetter = true; }
      else break;
    }
    return sawLetter ? n - 1 : 0;
  }

  async function xlsxToSheets(buf) {
    const shared = [];
    if (await Zip.list(buf).then(names => names.includes('xl/sharedStrings.xml'))) {
      const sst = parseXml(await Zip.extractText(buf, 'xl/sharedStrings.xml'));
      sst.querySelectorAll('si').forEach(si => {
        // concat all <t> (rich runs)
        let s = '';
        si.querySelectorAll('t').forEach(t => { s += t.textContent; });
        shared.push(s);
      });
    }
    // sheet name → target path via workbook + rels
    const wb = parseXml(await Zip.extractText(buf, 'xl/workbook.xml'));
    const rels = parseXml(await Zip.extractText(buf, 'xl/_rels/workbook.xml.rels'));
    const relMap = {};
    rels.querySelectorAll('Relationship').forEach(r => { relMap[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const sheets = [];
    wb.querySelectorAll('sheet').forEach(sh => {
      const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || '';
      let target = relMap[rid] || '';
      if (!target) return;
      if (target.startsWith('/')) target = target.slice(1);
      else if (!target.startsWith('xl/')) target = 'xl/' + target;
      sheets.push({ name: sh.getAttribute('name') || '', path: target });
    });
    const out = [];
    for (const sh of sheets) {
      let xml;
      try { xml = await Zip.extractText(buf, sh.path); } catch (e) { continue; }
      const doc = parseXml(xml);
      const rows = [];
      doc.querySelectorAll('sheetData > row').forEach(row => {
        const cells = [];
        let nextCol = 0;
        row.querySelectorAll('c').forEach(c => {
          const ref = c.getAttribute('r') || '';
          const col = ref ? colToIndex(ref) : nextCol;
          while (nextCol < col) { cells[nextCol] = ''; nextCol++; }
          let val = '';
          const t = c.getAttribute('t');
          if (t === 's') {
            const v = c.querySelector('v');
            val = v ? (shared[parseInt(v.textContent, 10)] || '') : '';
          } else if (t === 'inlineStr') {
            let s = '';
            c.querySelectorAll('t').forEach(x => { s += x.textContent; });
            val = s;
          } else {
            const v = c.querySelector('v');
            val = v ? v.textContent : '';
          }
          cells[col] = val;
          nextCol = col + 1;
        });
        rows.push(cells);
      });
      out.push({ name: sh.name, rows });
    }
    if (!out.length) throw new Error('xlsx: 未找到工作表');
    return out;
  }

  /* ---------- docx ---------- */

  function paraText(p) {
    let s = '';
    Array.from(p.getElementsByTagNameNS('*', 't')).forEach(t => { s += t.textContent; });
    return s.replace(/\u00a0/g, ' ');
  }

  async function docxToBlocks(buf) {
    const xml = await Zip.extractText(buf, 'word/document.xml');
    const doc = parseXml(xml);
    // OOXML elements are namespaced (w:p, w:tbl…) — match by local name only
    const body = doc.getElementsByTagNameNS('*', 'body')[0] || doc.documentElement;
    const paragraphs = [];
    const tables = [];
    for (const node of Array.from(body.children)) {
      const tag = node.localName;
      if (tag === 'p') {
        paragraphs.push(paraText(node));
      } else if (tag === 'tbl') {
        const rows = [];
        Array.from(node.getElementsByTagNameNS('*', 'tr')).forEach(tr => {
          const cells = [];
          Array.from(tr.getElementsByTagNameNS('*', 'tc')).forEach(tc => {
            const parts = [];
            Array.from(tc.getElementsByTagNameNS('*', 'p')).forEach(p => {
              const t = paraText(p).trim();
              if (t) parts.push(t);
            });
            cells.push(parts.join('\n'));
          });
          rows.push(cells);
        });
        if (rows.length) tables.push({ rows });
      }
    }
    return { paragraphs, tables };
  }

  /* Heuristic: does a string look like Chinese (majority CJK)? */
  function isCJK(s) {
    const cjk = (s.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    return cjk > 0 && cjk >= latin;
  }

  function latinRatio(s) {
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    return latin / Math.max(1, [...s].length);
  }

  /* Detect column roles from a bilingual table (rows incl. header).
   * Header names first (strict: 英文原文 must not match 中文 rules), then
   * content check (CJK-majority column = source) as fallback.
   * Returns {header, rows, srcCol, tgtCol, idCol} or null. */
  function sniffDocxTable(tableRows) {
    if (!tableRows.length || tableRows[0].length < 2) return null;
    const width = Math.max(...tableRows.map(r => r.length));
    const header = tableRows[0].map(h => (h || '').trim());
    const norm = header.map(h => h.toLowerCase());
    let srcCol = norm.findIndex(h => h.includes('中文') && !h.includes('英文'));
    if (srcCol < 0) srcCol = norm.findIndex(h => h.includes('原文') && !h.includes('英文'));
    if (srcCol < 0) srcCol = norm.findIndex(h => /中文|zh$|source|src/.test(h));
    let tgtCol = norm.findIndex((h, i) => i !== srcCol && (h.includes('英文') || /english|^en$|target|tgt/.test(h)));
    if (tgtCol < 0) tgtCol = norm.findIndex((h, i) => i !== srcCol && h.includes('译文'));
    // content validation / fallback over sample body rows
    const sample = tableRows.slice(1, 12);
    function colStat(c) {
      let cjk = 0, n = 0, lat = 0;
      for (const r of sample) {
        const v = (r[c] || '').trim();
        if (!v) continue;
        n++; if (isCJK(v)) cjk++; if (latinRatio(v) > 0.3) lat++;
      }
      return { cjkRatio: n ? cjk / n : 0, latinRatio: n ? lat / n : 0, n };
    }
    const srcStat = srcCol >= 0 ? colStat(srcCol) : { cjkRatio: 0, n: 0 };
    if (srcCol < 0 || srcStat.n === 0 || srcStat.cjkRatio < 0.5) {
      // content-based: most CJK column becomes source
      let best = -1, bestRatio = 0;
      for (let c = 0; c < width; c++) {
        const st = colStat(c);
        if (st.n && st.cjkRatio > bestRatio) { bestRatio = st.cjkRatio; best = c; }
      }
      if (best >= 0 && bestRatio >= 0.5) srcCol = best;
    }
    if (tgtCol < 0 || tgtCol === srcCol) {
      // most latin column among the rest
      let best = -1, bestRatio = 0;
      for (let c = 0; c < width; c++) {
        if (c === srcCol) continue;
        const st = colStat(c);
        if (st.n && st.latinRatio > bestRatio) { bestRatio = st.latinRatio; best = c; }
      }
      if (best >= 0) tgtCol = best; else tgtCol = srcCol === 0 ? 1 : 0;
    }
    if (srcCol < 0 || tgtCol < 0 || srcCol === tgtCol) return null;
    const idCol = norm.findIndex(h => /^id$|编号|句段/.test(h));
    return { header, rows: tableRows.slice(1), srcCol, tgtCol, idCol: idCol >= 0 && idCol !== srcCol && idCol !== tgtCol ? idCol : -1 };
  }

  /* Paragraph-level bilingual structure detection.
   * Returns {mode:'alternate'|'zh_then_en', pairs:[{src,tgt}]} or null. */
  function sniffDocxParagraphs(paragraphs) {
    const ps = paragraphs.map(p => (p || '').trim()).filter(Boolean);
    if (ps.length < 2) return null;
    const flags = ps.map(isCJK);
    const zhCount = flags.filter(Boolean).length;
    const enCount = ps.length - zhCount;
    if (!zhCount || !enCount) return null;
    // alternate: strictly alternating zh/en (allow en→en never; zh→zh never)
    let alt = true;
    for (let i = 1; i < ps.length; i++) { if (flags[i] === flags[i - 1]) { alt = false; break; } }
    if (alt && zhCount === Math.ceil(ps.length / 2)) {
      const pairs = [];
      for (let i = 0; i + 1 < ps.length; i += 2) pairs.push(flags[i] ? { src: ps[i], tgt: ps[i + 1] } : { src: ps[i + 1], tgt: ps[i] });
      return { mode: 'alternate', pairs };
    }
    // zh_then_en: a single switch point from CJK-run to latin-run
    let switchIdx = -1;
    for (let i = 1; i < ps.length; i++) {
      if (flags[i - 1] && !flags[i]) {
        // check monotonic from here on (allow few stragglers)
        let enBad = 0, rest = 0;
        for (let j = i; j < ps.length; j++) { rest++; if (flags[j]) enBad++; }
        if (rest && enBad / rest <= 0.15) { switchIdx = i; break; }
      }
    }
    if (switchIdx > 0) {
      const zh = ps.slice(0, switchIdx), en = ps.slice(switchIdx);
      const n = Math.min(zh.length, en.length);
      return { mode: 'zh_then_en', pairs: zh.slice(0, n).map((s, k) => ({ src: s, tgt: en[k] })), mismatch: Math.abs(zh.length - en.length) };
    }
    return null;
  }

  return { xlsxToSheets, docxToBlocks, sniffDocxTable, sniffDocxParagraphs, isCJK };
});
