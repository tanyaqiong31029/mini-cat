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

  /* XML 解析器可注入：浏览器用内置 DOMParser；Node 测试经 setXmlParser(linkedom) 注入 */
  let customParser = null;
  function setXmlParser(p) { customParser = p; }
  /* 命名空间兼容：浏览器 localName 无前缀；linkedom（测试）为 "w:body" 形式 */
  function local(el) {
    const n = (el && el.localName) || '';
    return n.includes(':') ? n.slice(n.indexOf(':') + 1) : n;
  }
  /* 按 localName 取后代元素；NS 查询不可用时（linkedom）降级为手动扫描 */
  function byTag(root, name) {
    if (typeof root.getElementsByTagNameNS === 'function') {
      const r = root.getElementsByTagNameNS('*', name);
      if (r && r.length) return r;
    }
    const out = [];
    const walk = (n) => {
      for (const c of (n.children || [])) {
        if (local(c) === name) out.push(c);
        walk(c);
      }
    };
    walk(root);
    return out;
  }

  function parseXml(text) {
    const DP = customParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DP) throw new Error('当前环境缺少 XML 解析器');
    const doc = new DP().parseFromString(text, 'application/xml');
    if (typeof doc.querySelector === 'function') {
      const pe = doc.querySelector('parsererror');
      if (pe) throw new Error('Office XML 解析失败');
    }
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
    Array.from(byTag(p, 't')).forEach(t => { s += t.textContent; });
    return s.replace(/\u00a0/g, ' ');
  }

  /* 运行级格式提取（加粗/斜体/下划线）：供修订回导保留审校人的格式调整 */
  function paraRuns(p) {
    const runs = [];
    const sameM = (a, b) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline;
    Array.from(byTag(p, 't')).forEach(t => {
      const text = t.textContent || '';
      if (!text) return;
      const marks = {};
      let n = t.parentNode;
      while (n && n !== p) {
        if (local(n) === 'r') {
          const rpr = Array.from(n.children || []).find(c => local(c) === 'rPr');
          if (rpr) Array.from(rpr.children).forEach(c => {
            const nm = local(c);
            const val = c.getAttribute('w:val');
            const on = nm === 'u' ? val !== 'none' : (val !== '0' && val !== 'false');
            if (nm === 'b') marks.bold = on;
            if (nm === 'i') marks.italic = on;
            if (nm === 'u') marks.underline = on;
          });
        }
        n = n.parentNode;
      }
      const last = runs[runs.length - 1];
      if (last && sameM(last, marks)) last.text += text;
      else runs.push(Object.assign({ text }, (marks.bold || marks.italic || marks.underline) ? marks : {}));
    });
    return runs;
  }

  /* 修订感知提取：final = 含 w:ins 的当前文本；original = 删除标记还原的修订前文本；
   * changes = 该段内 w:ins/w:del 的作者与时间（Word 修订模式自动署名）；
   * cmtIds = 段内 Word 批注锚点。 */
  function paraParts(p) {
    let final = '', original = '';
    const changes = new Map();
    Array.from(byTag(p, 't')).forEach(t => {
      final += t.textContent;
      let n = t.parentNode, inIns = false;
      while (n && n !== p) { if (local(n) === 'ins') { inIns = true; break; } n = n.parentNode; }
      if (!inIns) original += t.textContent;
    });
    Array.from(byTag(p, 'delText')).forEach(d => { original += d.textContent; });
    Array.from(byTag(p, 'ins')).concat(Array.from(byTag(p, 'del'))).forEach(el => {
      const key = (el.getAttribute('w:author') || '') + '|' + (el.getAttribute('w:date') || '');
      if (!changes.has(key)) changes.set(key, { author: el.getAttribute('w:author') || '', date: el.getAttribute('w:date') || '' });
    });
    const cmtIds = Array.from(byTag(p, 'commentRangeStart')).map(c2 => c2.getAttribute('w:id'));
    return {
      final: final.replace(/\u00a0/g, ' '),
      original: original.replace(/\u00a0/g, ' '),
      changes: [...changes.values()],
      cmtIds
    };
  }

  async function docxToBlocks(buf) {
    const xml = await Zip.extractText(buf, 'word/document.xml');
    const doc = parseXml(xml);
    // OOXML elements are namespaced (w:p, w:tbl…) — match by local name only
    const body = byTag(doc, 'body')[0] || doc.documentElement;
    const paragraphs = [];
    const tables = [];
    for (const node of Array.from(body.children)) {
      const tag = local(node);
      if (tag === 'p') {
        paragraphs.push(paraText(node));
      } else if (tag === 'tbl') {
        const rows = [];
        const rowTracked = [];   // [{row, col, author, date, original, final}] — Word 修订模式
        const rowComments = [];  // [{row, col, ids}]        — Word 批注锚点
        const cellRuns = [];     // [{row, col, runs}]       — 运行级格式（供修订回导保留）
        let rowIdx = 0;
        Array.from(byTag(node, 'tr')).forEach(tr => {
          const cells = [];
          let colIdx = 0;
          Array.from(byTag(tr, 'tc')).forEach(tc => {
            const parts = [];
            const cellTracked = [];
            const cellCmtIds = [];
            let cellRunsAll = [];
            Array.from(byTag(tc, 'p')).forEach(p => {
              const pp = paraParts(p);
              const t = pp.final.trim();
              if (t) parts.push(t);
              cellRunsAll = cellRunsAll.concat(paraRuns(p));
              if (cellRunsAll.length && parts.length > 1) cellRunsAll.push({ text: '\n' });
              if (pp.original.trim() && pp.original.trim() !== pp.final.trim()) {
                for (const ch of pp.changes) {
                  cellTracked.push({ col: colIdx, author: ch.author, date: ch.date, original: pp.original.trim(), final: pp.final.trim() });
                }
              }
              cellCmtIds.push(...pp.cmtIds);
            });
            cells.push(parts.join('\n'));
            for (const ct of cellTracked) rowTracked.push({ row: rowIdx, ...ct });
            if (cellCmtIds.length) rowComments.push({ row: rowIdx, col: colIdx, ids: cellCmtIds });
            if (cellRunsAll.some(r2 => r2.bold || r2.italic || r2.underline)) {
              cellRuns.push({ row: rowIdx, col: colIdx, runs: cellRunsAll });
            }
            colIdx++;
          });
          rows.push(cells);
          rowIdx++;
        });
        if (rows.length) tables.push({ rows, rowTracked, rowComments, cellRuns });
      }
    }
    // Word 批注内容（comments.xml）
    let comments = [];
    if (await Zip.list(buf).then(n => n.includes('word/comments.xml')).catch(() => false)) {
      const cdoc = parseXml(await Zip.extractText(buf, 'word/comments.xml'));
      Array.from(byTag(cdoc, 'comment')).forEach(c2 => {
        comments.push({
          id: c2.getAttribute('w:id'),
          author: c2.getAttribute('w:author') || '',
          date: c2.getAttribute('w:date') || '',
          text: paraText(c2).trim()
        });
      });
    }
    // 文件属性：最后修改人/时间（docProps/core.xml）
    let meta = {};
    if (await Zip.list(buf).then(n => n.includes('docProps/core.xml')).catch(() => false)) {
      try {
        const core = parseXml(await Zip.extractText(buf, 'docProps/core.xml'));
        const lastBy = byTag(core, 'lastModifiedBy')[0];
        const modified = byTag(core, 'modified')[0];
        meta = { lastModifiedBy: lastBy ? lastBy.textContent : '', modified: modified ? modified.textContent : '' };
      } catch (e) { /* 属性缺失不影响主流程 */ }
    }
    return { paragraphs, tables, comments, meta };
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
    // 回退：按语言分组配对——所有中文段按顺序，所有英文段按顺序，第 n 个中文配第 n 个英文
    const zhGrp = ps.filter((_, fi) => flags[fi]);
    const enGrp = ps.filter((_, fi) => !flags[fi]);
    const nP = Math.min(zhGrp.length, enGrp.length);
    if (nP > 0 && zhGrp.length > 2) {
      return {
        mode: 'grouped',
        pairs: zhGrp.slice(0, nP).map((z, k) => ({ src: z, tgt: enGrp[k] }))
      };
    }
    return null;
  }

  return { setXmlParser, xlsxToSheets, docxToBlocks, sniffDocxTable, sniffDocxParagraphs, isCJK };
});
