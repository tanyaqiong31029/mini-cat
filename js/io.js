/* Mini-CAT file I/O: TMX 1.4, TBX-Basic, CSV/TSV, JSONL, paste-pairs, backups.
 * Zero dependencies: XML via DOMParser, CSV hand-rolled, XLSX not supported (save as CSV from Excel). */
(function (root) {
  'use strict';
  const Core = (typeof module !== 'undefined' && module.exports)
    ? require('./core.js') : root.MiniCatCore;
  const RichText = (typeof module !== 'undefined' && module.exports)
    ? require('./richtext.js') : root.MiniCatRichText;

  /* ---------- text decoding ---------- */

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(file);
    }).then(buf => {
      // Try strict UTF-8; fall back to GBK (Excel-zh CSV) then lossy UTF-8.
      try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
      catch (e1) {
        try { return new TextDecoder('gbk').decode(buf); }
        catch (e2) { return new TextDecoder('utf-8').decode(buf); }
      }
    });
  }

  /* ---------- CSV / TSV ---------- */

  function detectDelimiter(text) {
    const line = (text.split(/\r?\n/).find(l => l.trim()) || '');
    const cand = [',', '\t', ';', '|'];
    let best = ',', bestN = -1;
    for (const d of cand) {
      const n = line.split(d).length;
      if (n > bestN) { bestN = n; best = d; }
    }
    return best;
  }

  function parseDelimited(text, delim) {
    if (delim === 'auto') delim = detectDelimiter(text);
    const rows = [];
    let row = [], cell = '', inQ = false;
    text = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else inQ = false;
        } else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') rows.push(row); }
    return rows;
  }

  function csvCell(v, delim) {
    v = String(v == null ? '' : v);
    if (new RegExp(`[${delim === '\t' ? '\t' : delim}"\n\r]`).test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  function buildDelimited(rows, delim) {
    return '\uFEFF' + rows.map(r => r.map(c => csvCell(c, delim)).join(delim)).join('\r\n');
  }

  /* Header-driven auto-mapping for bilingual tables (also used for xlsx/docx rows).
   * Returns {src,tgt,note,id} column indices (−1 = absent). */
  function mapBilingualHeader(header) {
    const norm = header.map(h => String(h || '').trim().toLowerCase());
    const find = (res) => norm.findIndex(h => res.some(r => h.includes(r)));
    return {
      src: find(['中文', '原文', 'zh', 'source', 'src']),
      tgt: find(['英文', '译文', '目标', 'en', 'english', 'target', 'tgt', '最终译法', '译法']),
      note: find(['备注', '说明', '定义', '语境', 'note', 'definition', '出处', '决策']),
      id: find(['id', '编号', '术语id'])
    };
  }

  function sniffBilingualTable(text, delim) {
    const table = parseDelimited(text, delim || 'auto');
    if (!table.length) return null;
    const header = table[0].map(h => h.trim());
    return { header, rows: table.slice(1), mapping: mapBilingualHeader(header) };
  }

  /* ---------- TMX ---------- */

  function parseTMX(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('TMX XML 解析失败：' + doc.querySelector('parsererror').textContent.slice(0, 120));
    const header = doc.querySelector('header');
    const srcLang = header ? (header.getAttribute('srclang') || 'zh') : 'zh';
    const props = {};
    if (header) header.querySelectorAll('prop').forEach(p => { props[p.getAttribute('type')] = p.textContent; });
    const tus = [];
    doc.querySelectorAll('body > tu').forEach(tu => {
      const tuProps = {};
      tu.querySelectorAll(':scope > prop').forEach(p => { tuProps[p.getAttribute('type')] = p.textContent; });
      const tuvs = tu.querySelectorAll(':scope > tuv');
      let src = '', tgt = '', srcLangTu = srcLang, tgtLangTu = '';
      const segs = [];
      tuvs.forEach(tuv => {
        const lang = (tuv.getAttribute('xml:lang') || '').toLowerCase();
        const seg = tuv.querySelector('seg');
        const content = seg ? seg.textContent.trim() : '';
        segs.push({ lang, content });
      });
      // zh → src, en → tgt (fall back to header srclang order)
      const zh = segs.find(s => s.lang.startsWith('zh'));
      const en = segs.find(s => s.lang.startsWith('en'));
      if (zh && en) { src = zh.content; tgt = en.content; srcLangTu = zh.lang; tgtLangTu = en.lang; }
      else if (segs.length >= 2) { src = segs[0].content; tgt = segs[1].content; srcLangTu = segs[0].lang; tgtLangTu = segs[1].lang; }
      if (src) tus.push({
        id: tu.getAttribute('tuid') || '',
        src, tgt, srcLang: srcLangTu, tgtLang: tgtLangTu, props: tuProps
      });
    });
    return { srcLang, props, tus };
  }

  function buildTMX(tus, meta) {
    meta = meta || {};
    const esc = Core.escapeHtml;
    const now = new Date();
    const d = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    let out = `<?xml version="1.0" encoding="UTF-8"?>\n<tmx version="1.4">\n<header creationtool="${esc(meta.creationtool || 'mini-cat')}" creationtoolversion="1.0.0" segtype="sentence" o-tmf="plain text" adminlang="zh-CN" srclang="${esc(meta.srcLang || 'zh-CN')}" datatype="plaintext" creationdate="${d}">\n`;
    (meta.props || []).forEach(p => { out += `<prop type="${esc(p.type)}">${esc(p.value)}</prop>\n`; });
    out += `</header>\n<body>\n`;
    for (const tu of tus) {
      out += `<tu tuid="${esc(tu.id || '')}">\n`;
      Object.entries(tu.props || {}).forEach(([k, v]) => { out += `<prop type="${esc(k)}">${esc(v)}</prop>\n`; });
      out += `<tuv xml:lang="${esc(tu.srcLang || 'zh-CN')}"><seg>${esc(tu.src)}</seg></tuv>\n`;
      out += `<tuv xml:lang="${esc(tu.tgtLang || 'en-US')}"><seg>${esc(tu.tgt)}</seg></tuv>\n`;
      out += `</tu>\n`;
    }
    out += `</body>\n</tmx>\n`;
    return out;
  }

  /* ---------- TBX-Basic ---------- */

  function parseTBX(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('TBX XML 解析失败：' + doc.querySelector('parsererror').textContent.slice(0, 120));
    const terms = [];
    doc.querySelectorAll('termEntry').forEach(te => {
      let zh = '', en = '', note = '', status = '', pos = '', subject = '';
      te.querySelectorAll(':scope > descrip').forEach(d => {
        if (d.getAttribute('type') === 'definition') note = d.textContent.trim();
        if (d.getAttribute('type') === 'subjectField') subject = d.textContent.trim();
      });
      te.querySelectorAll(':scope > admin').forEach(a => {
        if (a.getAttribute('type') === 'termStatus') status = a.textContent.trim();
        if (a.getAttribute('type') === 'note') note = (note ? note + '｜' : '') + a.textContent.trim();
      });
      te.querySelectorAll('langSet').forEach(ls => {
        const lang = (ls.getAttribute('xml:lang') || '').toLowerCase();
        ls.querySelectorAll('tig > term, langSec > term').forEach(t => {
          const val = t.textContent.trim();
          if (!val) return;
          if (lang.startsWith('zh') && !zh) zh = val;
          if ((lang.startsWith('en') || lang.startsWith('de') || lang.startsWith('fr')) && !en) en = val;
        });
      });
      te.querySelectorAll('termNote').forEach(tn => {
        if (tn.getAttribute('type') === 'partOfSpeech') pos = tn.textContent.trim();
      });
      if (zh) terms.push({ id: te.getAttribute('id') || '', zh, en, note, status, pos, subject });
    });
    return terms;
  }

  function buildTBX(terms, meta) {
    meta = meta || {};
    const esc = Core.escapeHtml;
    let out = `<?xml version="1.0" encoding="UTF-8"?>\n<martif type="TBX-Basic" xml:lang="zh-CN">\n<martifHeader><fileDesc><titleStmt><title>${esc(meta.title || 'Mini-CAT 术语库')}</title></titleStmt>\n<sourceDesc><p>${esc(meta.source || 'Exported from Mini-CAT')}</p></sourceDesc>\n</fileDesc>\n</martifHeader><text><body>\n`;
    terms.forEach((t, i) => {
      out += `<termEntry id="${esc(t.id || 'T' + String(i + 1).padStart(4, '0'))}">\n`;
      if (t.subject) out += `<descrip type="subjectField">${esc(t.subject)}</descrip>\n`;
      if (t.note) out += `<admin type="note">${esc(t.note)}</admin>\n`;
      out += `<langSet xml:lang="zh-CN"><tig><term>${esc(t.zh)}</term>${t.pos ? `<termNote type="partOfSpeech">${esc(t.pos)}</termNote>` : ''}</tig></langSet>\n`;
      if (t.en) out += `<langSet xml:lang="en-US"><tig><term>${esc(t.en)}</term>${t.pos ? `<termNote type="partOfSpeech">${esc(t.pos)}</termNote>` : ''}</tig></langSet>\n`;
      out += `</termEntry>\n`;
    });
    out += `</body></text>\n</martif>\n`;
    return out;
  }

  /* ---------- JSONL (porcelain-china-corpus parallel format) ---------- */

  function parseJSONL(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch (e) { /* skip bad line */ }
    }
    return rows;
  }

  // Map corpus JSONL {id, zh, en, chapter, ...} → TM rows
  function jsonlToTMRows(objects, project) {
    const rows = [];
    for (const o of objects) {
      const src = o.zh || o.src || o.source || '';
      const tgt = o.en || o.tgt || o.target || '';
      if (!src || !tgt) continue;
      rows.push({
        project, src, tgt,
        srcNorm: Core.normalizeCJK(src),
        bigrams: [...Core.bigrams(src)],
        note: [o.chapter && ('章节:' + o.chapter), o.section && ('节:' + o.section), o.fig && ('图:' + o.fig)].filter(Boolean).join(' '),
        origin: o.id ? ('corpus:' + o.id) : 'jsonl',
        date: new Date().toISOString().slice(0, 10)
      });
    }
    return rows;
  }

  /* ---------- paste pairs ---------- */

  // Align two plain texts by paragraph, then by sentence if counts mismatch.
  function alignPairTexts(srcText, tgtText) {
    const paras = t => String(t || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
    let S = paras(srcText), T = paras(tgtText);
    if (S.length !== T.length) {
      const sSent = S.flatMap(p => Core.splitSentences(p));
      const tSent = T.flatMap(p => Core.splitSentences(p));
      if (sSent.length === tSent.length) { S = sSent; T = tSent; }
      else {
        const n = Math.min(S.length, T.length);
        const mismatch = Math.abs(S.length - T.length);
        S = S.slice(0, n); T = T.slice(0, n);
        return { pairs: S.map((s, i) => ({ src: s, tgt: T[i] })), mismatch };
      }
    }
    return { pairs: S.map((s, i) => ({ src: s, tgt: T[i] })), mismatch: 0 };
  }


  /* ---------- 备份消毒（防跨浏览器 ID 覆盖与注入） ---------- */
  /* 校验备份结构；丢弃外来 ID（本机重新自增）；长度封顶；重算派生字段（srcNorm/bigrams
   * 不信任备份文件）；工作区 segments 白名单化。所有字符串字段转义责任在渲染层。 */
  function sanitizeBackup(data, opts) {
    opts = opts || {};
    const defaultProject = String(opts.defaultProject || '导入备份').slice(0, 120);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('备份格式无效');
    if (!Array.isArray(data.tm) || !Array.isArray(data.terms)) throw new Error('不是 Mini-CAT 备份文件（缺少 tm/terms）');
    const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const int01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(101, Math.round(n))) : 0; };

    const tm = data.tm
      .filter(r => r && typeof r === 'object' && typeof r.src === 'string' && r.src.trim() && typeof r.tgt === 'string')
      .map(r => {
        const src = r.src.slice(0, 20000);
        return {
          project: cap(r.project, 120) || defaultProject,
          src, tgt: r.tgt.slice(0, 20000),
          srcNorm: Core.normalizeCJK(src),
          bigrams: [...Core.bigrams(src)],
          note: cap(r.note, 4000),
          origin: cap(r.origin, 200),
          date: cap(r.date, 20),
          prevNorm: cap(r.prevNorm, 20000)
        }; // id 一律丢弃 → 本机 autoIncrement 重新分配
      });

    const terms = data.terms
      .filter(r => r && typeof r === 'object' && typeof r.zh === 'string' && r.zh.trim())
      .map(r => ({
        project: cap(r.project, 120) || defaultProject,
        zh: r.zh.slice(0, 500),
        en: cap(r.en, 2000),
        note: cap(r.note, 4000),
        status: cap(r.status, 60),
        pos: cap(r.pos, 60),
        subject: cap(r.subject, 300)
      }));

    const segOk = (sg) => sg && typeof sg === 'object' && typeof sg.src === 'string' && sg.src.trim();
    const segMap = (sg, includeHistory = true) => {
      if(includeHistory && Array.isArray(sg.alignmentHistory) && sg.alignmentHistory.length>100)throw new Error('句对调整历史超过 100 份，无法安全恢复，请拆分备份。');
      return ({
      src: sg.src.slice(0, 20000),
      tgt: typeof sg.tgt === 'string' ? sg.tgt.slice(0, 20000) : '',
      // Formatting is structured data only; canonical plain text always wins.
      tgtRuns: RichText.normalize(sg.tgtRuns, cap(sg.tgt, 20000)),
      status: sg.status === 'translated' ? 'translated' : 'untranslated',
      para: Number.isFinite(sg.para) ? sg.para : null,
      bestScore: int01(sg.bestScore),
      applied: !!sg.applied,
      mt: !!sg.mt,
      key0: cap(sg.key0, 20050),
      author: cap(sg.author, 120),
      joinNext: sg.joinNext===true,
      splitLink: sg.splitLink && typeof sg.splitLink.id==='string' && ['left','right'].includes(sg.splitLink.side)
        ? {id:cap(sg.splitLink.id,120),side:sg.splitLink.side} : undefined,
      alignmentHistory: includeHistory && Array.isArray(sg.alignmentHistory)
        ? sg.alignmentHistory.filter(segOk).map(h=>segMap(h,false)) : [],
      // 修订历史与批注必须随备份保留（审校留痕数据）
      revisions: Array.isArray(sg.revisions)
        ? sg.revisions.filter(r => r && typeof r === 'object' && typeof r.text === 'string').map(r => ({
            v: cap(r.v, 20), author: cap(r.author, 120), text: r.text.slice(0, 20000),
            runs: RichText.normalize(r.runs, r.text.slice(0, 20000)),
            date: cap(r.date, 30), note: cap(r.note, 1000)
          }))
        : [],
      comments: Array.isArray(sg.comments)
        ? sg.comments.filter(c => c && typeof c === 'object' && typeof c.text === 'string').map(c => ({
            author: cap(c.author, 120), text: c.text.slice(0, 2000), date: cap(c.date, 30)
          }))
        : [],
      matches: Array.isArray(sg.matches)
        ? sg.matches.slice(0, 5).filter(m => m && typeof m === 'object').map(m => ({
            score: int01(m.score), src: cap(m.src, 20000), tgt: cap(m.tgt, 20000),
            note: cap(m.note, 1000), origin: cap(m.origin, 200)
          }))
        : []
    });
    };
    const projects = Array.isArray(data.projects)
      ? data.projects
          .filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
          .map(p => ({
            name: p.name.slice(0, 120),
            created: cap(p.created, 30),
            updated: cap(p.updated, 30),
            segments: Array.isArray(p.segments) ? p.segments.filter(segOk).map(s=>segMap(s)) : []
          }))
      : [];

    return { version: 1, tm, terms, projects };
  }

  /* ---------- export helpers ---------- */

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 300);
  }

  const IO = {
    readAsText, parseDelimited, buildDelimited, sniffBilingualTable, mapBilingualHeader, sanitizeBackup,
    parseTMX, buildTMX, parseTBX, buildTBX, parseJSONL, jsonlToTMRows, alignPairTexts, download
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = IO;
  else root.MiniCatIO = IO;
})(typeof self !== 'undefined' ? self : this);
