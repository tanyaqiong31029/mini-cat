/* Mini-CAT application: UI wiring, workspace state, matching pipeline. */
(function () {
  'use strict';
  const Core = window.MiniCatCore, DB = window.MiniCatDB, IO = window.MiniCatIO;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];
  const esc = Core.escapeHtml;

  /* ---------------- state ---------------- */
  const state = {
    project: '',
    projects: [],
    tm: [],            // [{id, project, src, tgt, srcNorm, bigrams, note, origin, date}]
    tmIndex: null,
    terms: [],         // [{id, project, zh, en, note, status, pos, subject}]
    segments: [],      // [{src, tgt, status, bestScore, bestTgt, bestNote, matches}]
    filter: 'all',
    busy: false
  };

  const TM_BANDS = [
    { key: 'exact', label: '100% 精确' },
    { key: 'near', label: '95–99%' },
    { key: 'hi', label: '75–94%' },
    { key: 'lo', label: '50–74%' },
    { key: 'none', label: '无匹配' }
  ];

  /* ---------------- init ---------------- */
  async function init() {
    state.projects = (await DB.Projects.all()).map(p => p.name);
    state.project = await DB.Meta.get('activeProject', '') || state.projects[0] || '';
    if (!state.project) await createProject('瓷器中国试译', true);
    await refreshAll();
    bindEvents();
    await rematchAll(); // refresh match scores against current TM/TB after load
    log('就绪。所有数据仅保存在本浏览器（IndexedDB），不会上传。');
  }

  async function createProject(name, silent) {
    name = name.trim();
    if (!name) return;
    if (!state.projects.includes(name)) {
      await DB.Projects.put({ name, created: new Date().toISOString().slice(0, 10) });
      state.projects.push(name);
    }
    state.project = name;
    await DB.Meta.set('activeProject', name);
    if (!silent) await refreshAll();
  }

  async function refreshAll() {
    $('#projSelect').innerHTML = state.projects.map(p =>
      `<option value="${esc(p)}" ${p === state.project ? 'selected' : ''}>${esc(p)}</option>`).join('');
    state.tm = await DB.TM.all(state.project);
    state.terms = await DB.Terms.all(state.project);
    rebuildIndex();
    const proj = await DB.Projects.get(state.project) || { segments: [] };
    state.segments = proj.segments || [];
    await renderTerms();
    renderSegments();
    renderStats();
    $('#projectTitle').textContent = state.project;
  }

  function rebuildIndex() {
    state.tmIndex = Core.createTMIndex(state.tm.map(e => ({
      id: e.id, src: e.src, srcNorm: e.srcNorm, grams: e.bigrams || [...Core.bigrams(e.src)]
    })));
  }

  /* ---------------- matching ---------------- */

  async function rematchAll() {
    if (!state.segments.length) { renderSegments(); renderStats(); return; }
    setBusy(true, '正在匹配记忆库…');
    const CHUNK = 25;
    for (let i = 0; i < state.segments.length; i += CHUNK) {
      const slice = state.segments.slice(i, i + CHUNK);
      for (const seg of slice) matchSegment(seg);
      renderSegments();
      renderStats();
      await new Promise(r => setTimeout(r, 0));
      setBusy(true, `正在匹配记忆库… ${Math.min(i + CHUNK, state.segments.length)}/${state.segments.length}`);
    }
    setBusy(false);
    saveProjectDebounced();
  }

  function matchSegment(seg) {
    const hits = Core.findMatches(seg.src, state.tm, state.tmIndex, 50, 5);
    seg.matches = hits.map(h => ({ id: h.entry.id, score: h.score, src: h.entry.src, tgt: h.entry.tgt, note: h.entry.note, origin: h.entry.origin }));
    seg.bestScore = hits.length ? hits[0].score : 0;
    if (hits.length && seg.status !== 'translated' && seg.tgt == null) {
      seg.tgt = hits[0].score >= 100 ? hits[0].entry.tgt : hits[0].entry.tgt;
      seg.applied = hits[0].score >= 100;
    } else if (seg.tgt == null) seg.tgt = '';
  }

  /* ---------------- workspace import ---------------- */

  async function importSourceText(text, segMode) {
    const parts = segMode === 'paragraph'
      ? String(text).split(/\n+/).map(p => p.trim()).filter(Boolean)
      : Core.segmentText(text, 6);
    if (!parts.length) { alert('没有可导入的内容。'); return; }
    // skip duplicates of existing sources
    const exist = new Set(state.segments.map(s => Core.normalizeCJK(s.src)));
    let added = 0;
    for (const p of parts) {
      const key = Core.normalizeCJK(p);
      if (!key || exist.has(key)) continue;
      exist.add(key);
      state.segments.push({ src: p, tgt: null, status: 'untranslated', matches: [], bestScore: 0 });
      added++;
    }
    $('#log').prepend(Object.assign(document.createElement('div'), { textContent: `原文导入：新增 ${added} 段（共 ${state.segments.length} 段）。` }));
    await rematchAll();
    await saveProjectDebounced();
  }

  /* ---------------- TM / terms import ---------------- */

  function rowsToTM(rows, project) {
    const exist = new Set(state.tm.map(e => e.srcNorm + '\u0000' + e.tgt));
    const out = [];
    for (const r of rows) {
      const src = (r.src || '').trim(), tgt = (r.tgt || '').trim();
      if (!src) continue;
      const key = Core.normalizeCJK(src) + '\u0000' + tgt;
      if (exist.has(key)) continue;
      exist.add(key);
      out.push({
        project, src, tgt,
        srcNorm: Core.normalizeCJK(src),
        bigrams: [...Core.bigrams(src)],
        note: r.note || '', origin: r.origin || '', date: new Date().toISOString().slice(0, 10)
      });
    }
    return out;
  }

  async function addTmRows(rows, label) {
    const cleaned = rowsToTM(rows, state.project);
    if (!cleaned.length) { log(`${label}：没有新增句对（可能全部重复）。`); return 0; }
    await DB.TM.addMany(cleaned);
    state.tm = await DB.TM.all(state.project);
    rebuildIndex();
    log(`${label}：新增 ${cleaned.length} 条记忆。`);
    return cleaned.length;
  }

  function refineTermMapping(header, mapping) {
    // prefer "最终译法" style columns for target
    const finalIdx = header.findIndex(h => h.includes('最终'));
    if (finalIdx >= 0) mapping.tgt = finalIdx;
    const zhIdx = header.findIndex(h => h.includes('中文术语'));
    if (zhIdx >= 0) mapping.src = zhIdx;
    const noteIdx = header.findIndex(h => h.includes('语境') || h.includes('定义'));
    if (noteIdx >= 0) mapping.note = noteIdx;
    return mapping;
  }

  async function addTermRows(rows) {
    const exist = new Set(state.terms.map(t => t.zh));
    const out = [];
    for (const r of rows) {
      const zh = (r.zh || '').trim();
      if (!zh || exist.has(zh)) continue;
      exist.add(zh);
      out.push({ project: state.project, zh, en: r.en || '', note: r.note || '', status: r.status || '', pos: r.pos || '', subject: r.subject || '' });
    }
    if (!out.length) { log('术语库：没有新增术语。'); return 0; }
    await DB.Terms.addMany(out);
    state.terms = await DB.Terms.all(state.project);
    await renderTerms();
    renderSegments(); // re-highlight
    log(`术语库：新增 ${out.length} 条术语。`);
    return out.length;
  }

  /* ---------------- persistence ---------------- */

  let saveTimer = null;
  function saveProjectDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProjectNow, 600);
  }
  async function saveProjectNow() {
    const proj = await DB.Projects.get(state.project) || { name: state.project };
    proj.segments = state.segments;
    proj.updated = new Date().toISOString();
    await DB.Projects.put(proj);
  }
  window.addEventListener('beforeunload', () => { if (state.segments.length) saveProjectNow(); });

  /* ---------------- rendering ---------------- */

  function setBusy(b, msg) {
    state.busy = b;
    $('#busyBar').style.display = b ? '' : 'none';
    if (msg) $('#busyMsg').textContent = msg;
  }

  function log(msg) {
    const el = $('#log');
    const d = document.createElement('div');
    d.textContent = new Date().toTimeString().slice(0, 8) + '  ' + msg;
    el.prepend(d);
    while (el.children.length > 40) el.lastChild.remove();
  }

  function renderSegments() {
    const box = $('#segments');
    const terms = state.terms;
    const flt = state.filter;
    const html = [];
    for (let i = 0; i < state.segments.length; i++) {
      const seg = state.segments[i];
      const band = Core.matchBand(seg.bestScore || 0);
      if (flt === 'translated' && seg.status !== 'translated') continue;
      if (flt === 'untranslated' && seg.status === 'translated') continue;
      if (flt === 'exact' && band.key !== 'exact') continue;
      if (flt === 'fuzzy' && !(band.key.startsWith('fuzzy') || band.key === 'near')) continue;
      if (flt === 'none' && band.key !== 'none') continue;
      // source with term highlight
      const hits = Core.findTerms(seg.src, terms);
      let srcHtml;
      if (hits.length) {
        let h = '', pos = 0;
        for (const hit of hits) {
          h += esc(seg.src.slice(pos, hit.start));
          h += `<mark class="term" data-term="${esc(hit.term.en || hit.term.zh)}" title="${esc(hit.term.en || '')}${hit.term.note ? '｜' + esc(hit.term.note) : ''}">${esc(seg.src.slice(hit.start, hit.end))}</mark>`;
          pos = hit.end;
        }
        h += esc(seg.src.slice(pos));
        srcHtml = h;
      } else srcHtml = esc(seg.src);

      const exact = band.key === 'exact';
      html.push(`
      <div class="seg ${seg.status === 'translated' ? 'done' : ''} ${exact ? 'auto' : ''}" data-i="${i}">
        <div class="seg-head">
          <span class="idx">${i + 1}</span>
          <span class="badge ${band.cls}">${band.label}</span>
          ${seg.matches && seg.matches.length ? `<button class="linkbtn show-matches" data-i="${i}">候选 ${seg.matches.length}</button>` : ''}
          <span class="spacer"></span>
          ${seg.status === 'translated'
            ? `<button class="linkbtn undo-seg" data-i="${i}">撤销</button>`
            : `<button class="linkbtn confirm-seg" data-i="${i}">✓ 完成并入库</button>`}
        </div>
        <div class="seg-src">${srcHtml}</div>
        <textarea class="seg-tgt" data-i="${i}" rows="2" placeholder="输入译文…">${esc(seg.tgt || '')}</textarea>
      </div>`);
    }
    box.innerHTML = html.join('') || '<div class="empty">暂无句段。点击「导入原文」开始。</div>';
    // autosize textareas
    $$('.seg-tgt').forEach(t => { t.style.height = 'auto'; t.style.height = Math.max(44, t.scrollHeight + 2) + 'px'; });
  }

  function renderStats() {
    const total = state.segments.length;
    const done = state.segments.filter(s => s.status === 'translated').length;
    const zhChars = state.segments.reduce((a, s) => a + Core.cjkCount(s.src), 0);
    const enWords = state.segments.reduce((a, s) => a + (s.tgt ? s.tgt.trim().split(/\s+/).filter(Boolean).length : 0), 0);
    const dist = { exact: 0, near: 0, 'fuzzy-hi': 0, 'fuzzy-lo': 0, none: 0 };
    for (const s of state.segments) dist[Core.matchBand(s.bestScore || 0).key]++;
    $('#stats').innerHTML = `
      <span>段落 <b>${done}/${total}</b></span>
      <span>中文 <b>${zhChars}</b> 字</span>
      <span>英文 <b>${enWords}</b> 词</span>
      <span>记忆库 <b>${state.tm.length}</b></span>
      <span>术语 <b>${state.terms.length}</b></span>
      <span class="chips">
        <button class="chip ${state.filter === 'exact' ? 'on' : ''}" data-f="exact">100% ${dist.exact}</button>
        <button class="chip ${state.filter === 'near' ? 'on' : ''}" data-f="near">95-99 ${dist.near}</button>
        <button class="chip ${state.filter === 'fuzzy' ? 'on' : ''}" data-f="fuzzy">模糊 ${dist['fuzzy-hi'] + dist['fuzzy-lo']}</button>
        <button class="chip ${state.filter === 'none' ? 'on' : ''}" data-f="none">无 ${dist.none}</button>
        <button class="chip ${state.filter === 'all' ? 'on' : ''}" data-f="all">全部</button>
      </span>`;
  }

  function renderTerms() {
    const q = ($('#termSearch') && $('#termSearch').value.trim().toLowerCase()) || '';
    const list = state.terms.filter(t =>
      !q || t.zh.toLowerCase().includes(q) || (t.en || '').toLowerCase().includes(q));
    $('#termList').innerHTML = list.map(t => `
      <div class="term-row" data-id="${t.id}">
        <div class="term-pair"><b>${esc(t.zh)}</b><span class="arrow">→</span><span class="en">${esc(t.en || '<待译>')}</span></div>
        ${t.note ? `<div class="term-note">${esc(t.note)}</div>` : ''}
      </div>`).join('') || '<div class="empty">术语库为空。</div>';
  }

  function showMatchesFor(i) {
    const seg = state.segments[i];
    if (!seg || !seg.matches) return;
    $('#matchList').innerHTML = seg.matches.map(m => `
      <div class="match-row" data-tgt="${esc(m.tgt)}">
        <div class="match-head"><span class="badge ${Core.matchBand(m.score).cls}">${Core.matchBand(m.score).label}</span>
          <span class="origin">${esc(m.origin || '')}</span>
          <button class="linkbtn use-match">采用</button></div>
        <div class="match-src">${esc(m.src)}</div>
        <div class="match-tgt">${esc(m.tgt)}</div>
        ${m.note ? `<div class="term-note">${esc(m.note)}</div>` : ''}
      </div>`).join('') || '<div class="empty">无候选。</div>';
    $('#matchSegIdx').textContent = `段落 ${i + 1}`;
  }

  function runConcordance(q) {
    if (!q) { $('#concordList').innerHTML = ''; return; }
    const ql = q.toLowerCase();
    const out = [];
    for (const e of state.tm) {
      const i = e.src.toLowerCase().indexOf(ql);
      const j = (e.tgt || '').toLowerCase().indexOf(ql);
      if (i >= 0 || j >= 0) out.push({ e, i, j });
      if (out.length >= 100) break;
    }
    $('#concordList').innerHTML = out.map(({ e, i, j }) => `
      <div class="conc-row">
        <div class="match-src">${i >= 0 ? esc(e.src.slice(Math.max(0, i - 30), i + 60)) : esc(e.src.slice(0, 70))}</div>
        <div class="match-tgt">${j >= 0 ? esc((e.tgt || '').slice(Math.max(0, j - 30), j + 60)) : esc((e.tgt || '').slice(0, 70))}</div>
      </div>`).join('') || '<div class="empty">记忆库中无匹配。</div>';
  }

  /* ---------------- events ---------------- */

  function bindEvents() {
    $('#projNew').onclick = async () => {
      const name = prompt('新项目名称：');
      if (name) { await createProject(name); log('已切换到新项目：' + name); }
    };
    $('#projSelect').onchange = async (e) => {
      await saveProjectNow();
      state.project = e.target.value;
      await DB.Meta.set('activeProject', state.project);
      await refreshAll();
    };

    // stats filter chips
    $('#stats').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      state.filter = b.dataset.f;
      renderSegments(); renderStats();
    });

    // segment interactions
    $('#segments').addEventListener('input', e => {
      if (e.target.classList.contains('seg-tgt')) {
        const i = +e.target.dataset.i;
        state.segments[i].tgt = e.target.value;
        state.segments[i].applied = false;
        e.target.style.height = 'auto';
        e.target.style.height = Math.max(44, e.target.scrollHeight + 2) + 'px';
        saveProjectDebounced();
      }
    });
    $('#segments').addEventListener('click', async e => {
      const t = e.target;
      if (t.classList.contains('confirm-seg')) {
        const i = +t.dataset.i, seg = state.segments[i];
        seg.tgt = (seg.tgt || '').trim();
        if (!seg.tgt) { alert('译文为空。'); return; }
        seg.status = 'translated';
        await addTmRows([{ src: seg.src, tgt: seg.tgt, note: '译员确认', origin: '工作台' }], '入库');
        renderSegments(); renderStats(); saveProjectDebounced();
      } else if (t.classList.contains('undo-seg')) {
        const seg = state.segments[+t.dataset.i];
        seg.status = 'untranslated';
        renderSegments(); renderStats(); saveProjectDebounced();
      } else if (t.classList.contains('show-matches')) {
        showMatchesFor(+t.dataset.i);
        switchSide('match');
      } else if (t.classList.contains('term')) {
        // click term → open terms tab and search
        $('#termSearch').value = t.dataset.term || '';
        renderTerms(); switchSide('terms');
      }
    });

    // match panel: adopt
    $('#matchList').addEventListener('click', e => {
      if (!e.target.classList.contains('use-match')) return;
      const row = e.target.closest('.match-row');
      const idx = parseInt(($('#matchSegIdx').textContent.match(/\d+/) || [0])[0]) - 1;
      const ta = $(`.seg-tgt[data-i="${idx}"]`);
      if (ta) { ta.value = row.dataset.tgt; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    });

    // sidebar tabs
    $$('.side-tab').forEach(b => b.onclick = () => switchSide(b.dataset.tab));
    function switchSide(tab) {
      $$('.side-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
      $$('.side-pane').forEach(p => p.style.display = p.dataset.pane === tab ? '' : 'none');
    }
    state.switchSide = switchSide;

    $('#termSearch').oninput = renderTerms;
    $('#concordInput').oninput = e => runConcordance(e.target.value.trim());

    // toolbar
    $('#btnImportSource').onclick = () => $('#dlgSource').showModal();
    $('#btnImportTM').onclick = () => { prepareTmDialog(); $('#dlgTM').showModal(); };
    $('#btnImportTerms').onclick = () => $('#dlgTerms').showModal();
    $('#btnExport').onclick = () => $('#dlgExport').showModal();
    $('#btnRematch').onclick = async () => { await rematchAll(); log('已重新匹配。'); };
    $('#btnWipe').onclick = async () => {
      if (!confirm(`清空项目「${state.project}」的句段工作区？（记忆库和术语库不受影响）`)) return;
      state.segments = [];
      await DB.Projects.put({ name: state.project, segments: [] });
      renderSegments(); renderStats();
    };
    $('#btnBackup').onclick = exportBackup;
    $('#fileRestore').onchange = restoreBackup;

    /* ---- dialogs ---- */
    // source
    $('#srcSegMode').onchange = e => {};
    $('#btnSourceLoad').onclick = async () => {
      const f = $('#srcFile').files[0];
      const text = f ? await IO.readAsText(f) : $('#srcPaste').value;
      if (!text.trim()) { alert('请选择 txt/csv 文件或粘贴文本。'); return; }
      $('#dlgSource').close();
      await importSourceText(text, $('#srcSegMode').value);
    };

    // TM
    function prepareTmDialog() { $('#tmPasteSrc').value = ''; $('#tmPasteTgt').value = ''; $('#tmFile').value = ''; $('#tmMappingBox').innerHTML = ''; }

    $('#tmFile').onchange = async () => {
      const f = $('#tmFile').files[0]; if (!f) return;
      const text = await IO.readAsText(f);
      showTmPreview(text, f.name);
    };
    $('#btnTmPreviewPaste').onclick = () => {
      const s = $('#tmPasteSrc').value, t = $('#tmPasteTgt').value;
      if (!s.trim() || !t.trim()) { alert('两个粘贴框都需要内容。'); return; }
      const { pairs, mismatch } = IO.alignPairTexts(s, t);
      if (mismatch) log(`注意：两侧段落数不一致，已按句段对齐（差异 ${mismatch} 行）。`);
      $('#tmMappingBox').innerHTML = `
        <div class="mapping-note">对齐结果：<b>${pairs.length}</b> 对${mismatch ? `（差异 ${mismatch}，请人工检查）` : ''}</div>
        <div class="mapping-rows">${pairs.slice(0, 8).map(p => `<div class="mapping-row"><span>${esc(p.src.slice(0, 40))}</span><span>${esc(p.tgt.slice(0, 40))}</span></div>`).join('')}</div>`;
      $('#tmMappingBox').dataset.pairs = JSON.stringify(pairs.slice(0, 5000));
    };

    function showTmPreview(text, name) {
      try {
        if (/\.tmx$/i.test(name) || /<tmx[\s>]/i.test(text)) {
          const { tus } = IO.parseTMX(text);
          $('#tmMappingBox').innerHTML = `<div class="mapping-note">TMX：${tus.length} 个翻译单元，预览前 5 条：</div>` +
            tus.slice(0, 5).map(tu => `<div class="mapping-row"><span>${esc(tu.src.slice(0, 40))}</span><span>${esc(tu.tgt.slice(0, 40))}</span></div>`).join('');
          $('#tmMappingBox').dataset.tus = JSON.stringify(tus.slice(0, 20000));
        } else {
          const { header, rows, mapping } = IO.sniffBilingualTable(text);
          if (mapping.src < 0 || mapping.tgt < 0) { $('#tmMappingBox').innerHTML = '<div class="mapping-note">⚠️ 未识别出中文/译文列，请改用 TMX/JSONL 或粘贴方式。</div>'; return; }
          $('#tmMappingBox').innerHTML = `<div class="mapping-note">表格：源列=<b>${esc(header[mapping.src])}</b>，译文列=<b>${esc(header[mapping.tgt])}</b>，共 ${rows.length} 行。预览：</div>` +
            rows.slice(0, 5).map(r => `<div class="mapping-row"><span>${esc((r[mapping.src] || '').slice(0, 40))}</span><span>${esc((r[mapping.tgt] || '').slice(0, 40))}</span></div>`).join('');
          $('#tmMappingBox').dataset.rows = JSON.stringify({ header, rows: rows.slice(0, 20000), mapping });
        }
      } catch (err) { $('#tmMappingBox').innerHTML = `<div class="mapping-note">解析失败：${esc(err.message)}</div>`; }
    }

    $('#btnTmCommit').onclick = async () => {
      const box = $('#tmMappingBox');
      let rows = [];
      if (box.dataset.tus) {
        rows = JSON.parse(box.dataset.tus).map(tu => ({ src: tu.src, tgt: tu.tgt, note: tu.props ? Object.values(tu.props).join(' ') : '', origin: 'TMX' }));
      } else if (box.dataset.rows) {
        const { rows: tableRows, mapping } = JSON.parse(box.dataset.rows);
        rows = tableRows.map(r => ({ src: r[mapping.src], tgt: r[mapping.tgt], note: mapping.note >= 0 ? r[mapping.note] : '' }));
      } else if (box.dataset.pairs) {
        rows = JSON.parse(box.dataset.pairs).map(p => ({ src: p.src, tgt: p.tgt, origin: '粘贴对齐' }));
      } else { alert('请先选择文件或生成粘贴对齐预览。'); return; }
      const n = await addTmRows(rows, '记忆库导入');
      $('#dlgTM').close();
      await rematchAll();
    };

    // terms
    $('#termFile').onchange = async () => {
      const f = $('#termFile').files[0]; if (!f) return;
      const text = await IO.readAsText(f);
      try {
        let rows;
        if (/\.tbx$/i.test(f.name) || /<martif/i.test(text)) {
          rows = IO.parseTBX(text);
        } else {
          const { header, rows: tableRows, mapping } = IO.sniffBilingualTable(text);
          refineTermMapping(header, mapping);
          if (mapping.src < 0) { alert('未识别出中文术语列。'); return; }
          // porcelain_termbase.csv convention: fall back to 2025译法 when 2026最终译法 is empty
          const fallbackIdx = header.findIndex(h => h.includes('2025'));
          rows = tableRows.map(r => ({
            zh: r[mapping.src], en: (mapping.tgt >= 0 ? (r[mapping.tgt] || '').trim() : '') || (fallbackIdx >= 0 ? (r[fallbackIdx] || '').trim() : ''),
            note: [mapping.note >= 0 ? r[mapping.note] : '', mapping.id >= 0 ? '' : ''].filter(Boolean).join('｜')
          }));
        }
        $('#termMappingBox').innerHTML = `<div class="mapping-note">解析到 <b>${rows.length}</b> 条术语，预览：</div>` +
          rows.slice(0, 6).map(t => `<div class="mapping-row"><span>${esc(t.zh.slice(0, 24))}</span><span>${esc((t.en || '').slice(0, 40))}</span></div>`).join('');
        $('#termMappingBox').dataset.rows = JSON.stringify(rows.slice(0, 20000));
      } catch (err) { $('#termMappingBox').innerHTML = `<div class="mapping-note">解析失败：${esc(err.message)}</div>`; }
    };
    $('#btnTermCommit').onclick = async () => {
      const box = $('#termMappingBox');
      if (!box.dataset.rows) { alert('请先选择文件。'); return; }
      await addTermRows(JSON.parse(box.dataset.rows));
      $('#dlgTerms').close();
    };

    // export
    $('#btnExpTarget').onclick = () => {
      const txt = state.segments.filter(s => s.status === 'translated').map(s => s.tgt).join('\n\n');
      IO.download(`译文_${state.project}_${today()}.txt`, txt || '(无已译段落)', 'text/plain;charset=utf-8');
    };
    $('#btnExpBilingual').onclick = () => {
      const rows = [['#', '状态', '匹配', '中文', '英文']]
        .concat(state.segments.map((s, i) => [i + 1, s.status === 'translated' ? '已译' : '未译', s.bestScore || 0, s.src, s.tgt || '']));
      const html = bilingualHtml(rows);
      IO.download(`双语对照_${state.project}_${today()}.html`, html, 'text/html;charset=utf-8');
    };
    $('#btnExpTMX').onclick = () => {
      const tus = state.tm.map(e => ({ id: '', src: e.src, tgt: e.tgt, props: { 'x-project': state.project, 'x-origin': e.origin || '', 'x-note': e.note || '' } }));
      IO.download(`记忆库_${state.project}_${today()}.tmx`, IO.buildTMX(tus), 'application/x-tmx+xml');
    };
    $('#btnExpTmCsv').onclick = () => {
      const rows = [['中文', '英文', '备注', '来源', '日期']].concat(state.tm.map(e => [e.src, e.tgt, e.note || '', e.origin || '', e.date || '']));
      IO.download(`记忆库_${state.project}_${today()}.csv`, IO.buildDelimited(rows, ','), 'text/csv;charset=utf-8');
    };
    $('#btnExpTbxBasic').onclick = () => {
      IO.download(`术语库_${state.project}_${today()}.tbx`, IO.buildTBX(state.terms, { title: state.project }), 'application/xml');
    };
    $('#btnExpTermCsv').onclick = () => {
      const rows = [['中文术语', '英文术语', '备注', '状态', '词性']].concat(state.terms.map(t => [t.zh, t.en, t.note, t.status, t.pos]));
      IO.download(`术语库_${state.project}_${today()}.csv`, IO.buildDelimited(rows, ','), 'text/csv;charset=utf-8');
    };
    $('#btnExpJsonl').onclick = () => {
      const lines = state.tm.map(e => JSON.stringify({ zh: e.src, en: e.tgt, note: e.note, origin: e.origin, date: e.date }));
      IO.download(`平行语料_${state.project}_${today()}.jsonl`, lines.join('\n'), 'application/x-ndjson');
    };

    /* backup */
    async function exportBackup() {
      const all = { version: 1, exported: new Date().toISOString(), projects: await DB.Projects.all(), tm: await DB.TM.all(), terms: await DB.Terms.all() };
      IO.download(`mini-cat备份_${today()}.json`, JSON.stringify(all, null, 1), 'application/json');
    }
    async function restoreBackup(e) {
      const f = e.target.files[0]; if (!f) return;
      const text = await IO.readAsText(f);
      try {
        const data = JSON.parse(text);
        if (!data.tm || !data.terms) throw new Error('不是 Mini-CAT 备份文件');
        if (!confirm(`恢复备份：记忆 ${data.tm.length} 条、术语 ${data.terms.length} 条、项目 ${data.projects.length} 个。\n将与现有数据合并（重复自动跳过）。继续？`)) return;
        await DB.TM.addMany(data.tm);
        await DB.Terms.addMany(data.terms);
        for (const p of data.projects) await DB.Projects.put(p);
        state.projects = (await DB.Projects.all()).map(p => p.name);
        await refreshAll();
        log(`备份恢复完成：记忆 ${data.tm.length}、术语 ${data.terms.length}。`);
      } catch (err) { alert('恢复失败：' + err.message); }
    }

    function today() { return new Date().toISOString().slice(0, 10); }

    function bilingualHtml(rows) {
      const escH = Core.escapeHtml;
      let h = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>双语对照 ${escH(state.project)}</title>
      <style>body{font-family:'Songti SC',SimSun,Georgia,serif;margin:40px auto;max-width:1000px;color:#222}
      table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #bbb;padding:6px 8px;vertical-align:top;text-align:left}
      th{background:#f2ede4}tr:nth-child(even) td{background:#faf8f4}.zh{width:38%}.en{width:42%}</style></head><body>
      <h2>双语对照 — ${escH(state.project)}</h2><p>Mini-CAT 导出 · ${today()}</p>
      <table><tr><th>#</th><th>状态</th><th>匹配</th><th class="zh">中文</th><th class="en">英文</th></tr>`;
      for (const r of rows.slice(1)) {
        h += `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${escH(r[3])}</td><td>${escH(r[4])}</td></tr>`;
      }
      h += '</table></body></html>';
      return h;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
