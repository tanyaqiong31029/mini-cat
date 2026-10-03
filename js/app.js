/* Mini-CAT application: UI wiring, workspace state, matching pipeline. */
(function () {
  'use strict';
  const Core = window.MiniCatCore, DB = window.MiniCatDB, IO = window.MiniCatIO, Office = window.MiniCatOffice, Write = window.MiniCatWrite, Web = window.MiniCatWebRef, Diff = window.MiniCatDiff, SR = window.MiniCatStyleRules;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => [...document.querySelectorAll(sel)];
  const esc = Core.escapeHtml;
  const Rich = window.MiniCatRichText;
  const SegmentOps = window.MiniCatSegmentOps;

  /* ---------------- state ---------------- */
  // 队列投影版本号：本页排队中的保存全部完成后 DB 将达到的 rev（expectedRev 取它，避免同页连续保存自我冲突）
  let projectedRev = 0;
  const state = {
    project: '',
    projects: [],
    tm: [],            // [{id, project, src, tgt, srcNorm, bigrams, note, origin, date}]
    tmIndex: null,
    terms: [],         // [{id, project, zh, en, note, status, pos, subject}]
    segments: [],      // [{src, tgt, status, bestScore, bestTgt, bestNote, matches}]
    filter: 'all',
    webrefRequest: 0,
    pairUndo: [],
    busy: false,
    rev: 0,            // 当前项目记录版本号（多标签页 CAS 保护）
    pendingConflict: null
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
    state.author = (await DB.Meta.get('authorName', '')) || '';
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
    await withWorkspaceLocked(async () => {
      if (state.project) await saveProjectNow();
      if (!state.projects.includes(name)) {
        await DB.Projects.put({ name, created: new Date().toISOString().slice(0, 10) });
        state.projects.push(name);
      }
      state.project = name;
      await DB.Meta.set('activeProject', name);
      if (!silent) await refreshAll();
    });
  }

  async function refreshAll() {
    state.pairUndo = [];
    $('#btnPairUndo').disabled = true;
    state.webrefRequest++;
    state.webrefTerm = null;
    $('#webrefList').innerHTML = '<div class="empty">输入关键词后按回车查阅。</div>';
    $('#webrefStatus').textContent = '';
    $('#projSelect').innerHTML = state.projects.map(p =>
      `<option value="${esc(p)}" ${p === state.project ? 'selected' : ''}>${esc(p)}</option>`).join('');
    state.tm = await DB.TM.all(state.project);
    state.terms = await DB.Terms.all(state.project);
    rebuildIndex();
    const proj = await DB.Projects.get(state.project) || { segments: [] };
    state.segments = proj.segments || [];
    state.rev = typeof proj.rev === 'number' ? proj.rev : 0;
    projectedRev = state.rev;
    await renderTerms();
    renderSegments();
    renderStats();
    $('#projectTitle').textContent = state.project;
    acquireProjectLock(state.project);
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
      for (let k = i; k < Math.min(i + CHUNK, state.segments.length); k++) {
        const seg = state.segments[k];
        const prev = k > 0 ? state.segments[k - 1] : null;
        // ICE context: preceding segment within the same paragraph
        const prevNorm = (prev && prev.para != null && seg.para != null && prev.para === seg.para)
          ? Core.normalizeCJK(prev.src) : '';
        matchSegment(seg, prevNorm);
      }
      renderSegments();
      renderStats();
      await new Promise(r => setTimeout(r, 0));
      setBusy(true, `正在匹配记忆库… ${Math.min(i + CHUNK, state.segments.length)}/${state.segments.length}`);
    }
    setBusy(false);
    saveProjectDebounced();
  }

  function matchSegment(seg, prevNorm) {
    const hits = Core.findMatches(seg.src, state.tm, state.tmIndex, 50, 5, prevNorm);
    seg.matches = hits.map(h => ({ id: h.entry.id, score: h.score, src: h.entry.src, tgt: h.entry.tgt, note: h.entry.note, origin: h.entry.origin }));
    seg.bestScore = hits.length ? hits[0].score : 0;
    if (hits.length && seg.status !== 'translated' && seg.tgt == null) {
      seg.tgt = hits[0].entry.tgt;
      seg.applied = hits[0].score >= 100;
    } else if (seg.tgt == null) seg.tgt = '';
  }

  /* ---------------- workspace import ---------------- */

  async function importSourceText(text, segMode) {
    const paras = String(text).split(/\n+/).map(p => p.trim()).filter(Boolean);
    // 去重键 = 源文归一化 + 本次导入内的相对位置：同一次导入中重复出现的段落各自保留
    // （[A,B,A] 不再坍缩为 [A,B]），重复导入同一文件仍整体跳过。
    const exist = new Set(state.segments.flatMap(s2 => [s2.key0 || Core.normalizeCJK(s2.src),...(s2.alignmentHistory||[]).map(h=>h.key0||Core.normalizeCJK(h.src))]));
    let added = 0, paraBase = state.segments.length ? (state.segments[state.segments.length - 1].para ?? -1) + 1 : 0;
    const newSegs = [];
    if (segMode === 'paragraph') {
      for (let pi = 0; pi < paras.length; pi++) newSegs.push({ src: paras[pi], para: paraBase + pi, rel: pi });
    } else {
      let rel = 0;
      for (let pi = 0; pi < paras.length; pi++) {
        for (const s of Core.segmentText(paras[pi], 6)) { newSegs.push({ src: s, para: paraBase + pi, rel: rel++ }); }
      }
    }
    for (const seg of newSegs) {
      const norm = Core.normalizeCJK(seg.src);
      if (!norm) continue;
      const key = norm + '@' + seg.rel;
      if (exist.has(key) || exist.has(norm)) continue; // 位置键精确去重；旧版遗留记录按源文保守去重
      exist.add(key);
      state.segments.push({ src: seg.src, tgt: null, status: 'untranslated', matches: [], bestScore: 0, para: seg.para, key0: key });
      added++;
    }
    $('#log').prepend(Object.assign(document.createElement('div'), { textContent: `原文导入：新增 ${added} 段（共 ${state.segments.length} 段）。` }));
    await saveProjectNow();
    await rematchAll();
  }

  /* ---------------- TM / terms import ---------------- */

  function rowsToTM(rows, project) {
    const exist = new Set(state.tm.map(e => e.srcNorm + '\u0000' + e.tgt));
    const out = [];
    let prevNorm = '';
    for (const r of rows) {
      const src = (r.src || '').trim(), tgt = (r.tgt || '').trim();
      if (!src) continue;
      const key = Core.normalizeCJK(src) + '\u0000' + tgt;
      if (!exist.has(key)) {
        exist.add(key);
        out.push({
          project, src, tgt,
          srcNorm: Core.normalizeCJK(src),
          bigrams: [...Core.bigrams(src)],
          note: r.note || '', origin: r.origin || '', date: new Date().toISOString().slice(0, 10),
          prevNorm: r.prevNorm !== undefined ? r.prevNorm : prevNorm // ICE context; batches without explicit context use previous TU
        });
      }
      prevNorm = Core.normalizeCJK(src); // duplicates still advance context
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
  let saveQueue = Promise.resolve();
  let workspaceLocks = 0;
  async function withWorkspaceLocked(action) {
    workspaceLocks++;
    document.body.inert = true;
    try { return await action(); }
    finally { document.body.inert = --workspaceLocks > 0; }
  }
  function saveProjectDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveProjectNow().catch(() => log('保存失败，请备份并重试。')), 600);
  }
  function saveProjectNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!state.project) return saveQueue;
    // Capture before awaiting: a later project switch/edit must not change this write.
    const name = state.project;
    const segments = structuredClone(state.segments);
    const updated = new Date().toISOString();
    const expectedRev = projectedRev;
    projectedRev = expectedRev + 1; // 乐观推进：saveQueue 串行，同页下一次保存的期望值随之 +1；写入失败或冲突时回滚为 DB 真实值
    const pending = saveQueue.catch(() => {}).then(async () => {
      let r;
      try {
        r = await DB.Projects.saveWithRev(name, expectedRev, { created: undefined, segments, updated });
      } catch (err) {
        projectedRev = expectedRev; // 写入未落地（如存储失败注入）：投影回滚，允许紧接的回退保存
        throw err;
      }
      if (r.ok) { state.rev = r.newRev; return; }
      // 版本冲突：另一标签页已保存过。绝不静默覆盖——展示冲突横幅等待用户选择。
      projectedRev = r.currentRev; state.rev = r.currentRev;
      state.pendingConflict = { name, segments, updated, currentRev: r.currentRev, otherCount: r.segments.length };
      showConflictBanner();
    });
    saveQueue = pending;
    return pending;
  }
  /* 多标签页：Web Locks 建议锁（持有方正常编辑；未取得锁的页显示提醒）。
   * 硬保护由 saveWithRev 的版本 CAS 承担，锁仅用于提前告知。 */
  let releaseProjectLock = null;
  async function acquireProjectLock(name) {
    try {
      if (releaseProjectLock) { const f = releaseProjectLock; releaseProjectLock = null; f(); }
      if (!navigator.locks || !navigator.locks.request) return;
      let releaseFn = null;
      const held = new Promise(res => { releaseFn = res; });
      // 5 秒内未取得锁（如排队在旧文档之后）则放弃建议锁——CAS 仍是硬保护
      const timeout = new Promise(res => setTimeout(res, 5000));
      navigator.locks.request('mini-cat:project:' + name, { ifAvailable: true }, lock => {
        if (!lock) { showTabLockBanner(); return; }
        return Promise.race([held, timeout]).then(() => { if (releaseProjectLock === releaseFn) releaseProjectLock = null; });
      }).catch(() => {});
      releaseProjectLock = releaseFn;
    } catch (e) { /* 环境不支持则跳过 */ }
  }
  function showConflictBanner() {
    const b = $('#conflictBanner');
    if (!b) return;
    const pc = state.pendingConflict || {};
    $('#conflictText').textContent = `项目「${pc.name}」已在其他标签页被修改并保存（对方现有 ${pc.otherCount} 段，本页 ${state.segments.length} 段）。为防覆盖，本页自动保存已被暂停。`;
    b.style.display = '';
  }
  function showTabLockBanner() {
    const b = $('#tabLockBanner');
    if (b) b.style.display = '';
  }

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
      if (flt === 'ice' && band.key !== 'ice') continue;
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

      const exact = band.key === 'exact' || band.key === 'ice';
      html.push(`
      <div class="seg ${seg.status === 'translated' ? 'done' : ''} ${exact ? 'auto' : ''}" data-i="${i}">
        <div class="seg-head">
          <span class="idx">${i + 1}</span>
          <span class="badge ${band.cls}">${band.label}</span>
          ${seg.matches && seg.matches.length ? `<button class="linkbtn show-matches" data-i="${i}">候选 ${seg.matches.length}</button>` : ''}
          <span class="spacer"></span>
          <button type="button" class="linkbtn split-seg" data-i="${i}">拆分句对</button>
          <button type="button" class="linkbtn merge-seg" data-i="${i}" ${i+1>=state.segments.length?'disabled':''}>与下一句合并</button>
          ${seg.alignmentHistory&&seg.alignmentHistory.length?`<button type="button" class="linkbtn pair-history" data-i="${i}">调整前记录</button>`:''}
          ${seg.status === 'translated'
            ? `<button class="linkbtn undo-seg" data-i="${i}">撤销</button>`
            : `<button class="linkbtn confirm-seg" data-i="${i}">✓ 完成并入库</button>`}
          ${seg.revisions && seg.revisions.length ? `<button class="linkbtn rev-btn" data-i="${i}">⏱修订 ${seg.revisions.length}</button>` : ''}
          <button class="linkbtn cmt-btn" data-i="${i}">💬${seg.comments && seg.comments.length ? seg.comments.length : ''}</button>
        </div>
        <div class="seg-src">${srcHtml}</div>
        <div class="format-bar" role="toolbar" aria-label="译文格式">
          <button type="button" data-format="bold" title="加粗 Ctrl/Cmd+B"><b>B</b></button>
          <button type="button" data-format="italic" title="斜体 Ctrl/Cmd+I"><i>I</i></button>
          <button type="button" data-format="underline" title="下划线 Ctrl/Cmd+U"><u>U</u></button>
          <button type="button" data-format="superscript" title="上标">x²</button>
          <button type="button" data-format="subscript" title="下标">x₂</button>
          <button type="button" data-format="clear">清除格式</button>
          <span>选中译文后设置</span>
        </div>
        <div class="seg-tgt" data-i="${i}" contenteditable="true" role="textbox" aria-multiline="true" aria-label="第 ${i + 1} 段译文" data-placeholder="输入译文…">${Rich.toHTML(seg.tgtRuns, seg.tgt || '')}</div>
        <div class="seg-extra" data-i="${i}" hidden></div>
      </div>`);
    }
    box.innerHTML = html.join('') || '<div class="empty">暂无句段。点击「导入原文」开始。</div>';
  }

  function renderStats() {
    const total = state.segments.length;
    const done = state.segments.filter(s => s.status === 'translated').length;
    const zhChars = state.segments.reduce((a, s) => a + Core.cjkCount(s.src), 0);
    const enWords = state.segments.reduce((a, s) => a + (s.tgt ? s.tgt.trim().split(/\s+/).filter(Boolean).length : 0), 0);
    const dist = { ice: 0, exact: 0, near: 0, 'fuzzy-hi': 0, 'fuzzy-lo': 0, none: 0 };
    for (const s of state.segments) dist[Core.matchBand(s.bestScore || 0).key]++;
    $('#stats').innerHTML = `
      <span>段落 <b>${done}/${total}</b></span>
      <span>中文 <b>${zhChars}</b> 字</span>
      <span>英文 <b>${enWords}</b> 词</span>
      <span>记忆库 <b>${state.tm.length}</b></span>
      <span>术语 <b>${state.terms.length}</b></span>
      <span class="chips">
        <button class="chip ${state.filter === 'ice' ? 'on' : ''}" data-f="ice">101% ${dist.ice}</button>
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
      <div class="term-row" data-id="${esc(t.id)}">
        <div class="term-pair"><b>${esc(t.zh)}</b><span class="arrow">→</span><span class="en">${esc(t.en || '<待译>')}</span>
          <button class="linkbtn webref-go" data-id="${esc(String(t.id))}" title="联网查阅该术语">🌐</button></div>
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
      if (name) {
        try { await createProject(name); log('已切换到新项目：' + name); }
        catch (_) { log('保存或新建项目失败，请重试；不要关闭页面。'); }
      }
    };
    $('#projSelect').onchange = async (e) => {
      const next = e.target.value;
      try {
        await withWorkspaceLocked(async () => {
          await saveProjectNow();
          state.project = next;
          await DB.Meta.set('activeProject', next);
          await refreshAll();
        });
      } catch (_) { $('#projSelect').value = state.project; log('保存或切换失败，请重试；不要关闭页面。'); }
    };

    // stats filter chips
    $('#stats').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      state.filter = b.dataset.f;
      renderSegments(); renderStats();
    });

    // segment interactions
    let segmentEdit = null;
    function previewSegmentEdit() {
      if(!segmentEdit)return;
      try {
        let result;
        const i=segmentEdit.index;
        if(segmentEdit.mode==='split'){
          if(segmentEdit.sourceCut==null||segmentEdit.targetCut==null)throw new Error('请分别点击原文、译文的拆分位置。空译文可直接拆分原文。');
          result=SegmentOps.split(state.segments[i],segmentEdit.sourceCut,segmentEdit.targetCut,segmentEdit.id);
        }else result=[SegmentOps.merge(state.segments[i],state.segments[i+1],$('#mergeMode').value)];
        $('#segmentEditPreview').innerHTML=result.map((s,j)=>`<div class="pair-preview"><b>调整后句对 ${j+1}</b><div class="seg-src">${esc(s.src)}</div><div class="pair-target">${Rich.toHTML(s.tgtRuns,s.tgt)||'（空译文，待补充）'}</div></div>`).join('');
        $('#segmentEditStatus').textContent='原文、译文和格式按预览保存。调整后需重新确认；记忆库旧记录不自动删除。';
        $('#btnSegmentCommit').disabled=false;
      }catch(error){$('#segmentEditPreview').innerHTML='';$('#segmentEditStatus').textContent=error.message;$('#btnSegmentCommit').disabled=true;}
    }
    function openSegmentEdit(i,mode){
      const seg=state.segments[i];if(!seg||mode==='merge'&&!state.segments[i+1])return;
      segmentEdit={index:i,mode,project:state.project,snapshot:JSON.stringify(state.segments),sourceCut:null,targetCut:seg.tgt?null:0,id:crypto.randomUUID()};
      $('#segmentEditTitle').textContent=mode==='split'?`拆分第 ${i+1} 条句对`:`合并第 ${i+1}、${i+2} 条句对`;
      $('#segmentEditHint').textContent=mode==='split'?'在两个只读文本框中分别点击分割点，下方预览左右两条句对。不会按中英文字符比例猜测位置。':'合并实际相邻的两条句对，即使筛选界面隐藏了其中一条。请核对预览；跨原文段落默认保留换行。';
      $('#splitControls').hidden=mode!=='split';$('#mergeControls').hidden=mode!=='merge';$('#mergeMode').value='auto';
      $('#splitSource').value=seg.src;$('#splitTarget').value=seg.tgt||'';
      $('#dlgSegmentEdit').showModal();previewSegmentEdit();
    }
    for(const [id,field] of [['splitSource','sourceCut'],['splitTarget','targetCut']]){
      for(const event of ['click','keyup','select'])$('#'+id).addEventListener(event,()=>{
        if(!segmentEdit||segmentEdit.mode!=='split')return;
        segmentEdit[field]=$('#'+id).selectionStart;previewSegmentEdit();
      });
    }
    $('#mergeMode').onchange=previewSegmentEdit;
    $('#dlgSegmentEdit').addEventListener('close',()=>{segmentEdit=null;});
    async function writeAdjustedSegments(next,label,record=true){
      await withWorkspaceLocked(async()=>{
        await saveProjectNow();
        const before=structuredClone(state.segments);
        try {
          state.segments=next;state.filter='all';
          $('#matchList').innerHTML='';$('#matchSegIdx').textContent='段落 –';
          await rematchAll();await saveProjectNow();
          if(record){state.pairUndo.push({project:state.project,before,after:JSON.stringify(state.segments)});if(state.pairUndo.length>20)state.pairUndo.shift();}
          $('#btnPairUndo').disabled=!state.pairUndo.length;
          log(label+'。已保存；调整前修订与批注可在「调整前记录」查看。');
        }catch(error){
          clearTimeout(saveTimer);saveTimer=null;
          state.segments=before;setBusy(false);renderSegments();renderStats();
          // Re-persist the original snapshot, including when a storage wrapper
          // reports failure after its transaction has actually committed.
          try {await saveProjectNow();}
          catch(_){throw new Error(error.message+'；回退内容也未能保存，请保持页面打开并立即导出备份。');}
          throw error;
        }
      });
    }
    $('#btnSegmentCommit').onclick=async()=>{
      if(!segmentEdit)return;
      const edit=segmentEdit;
      if(edit.project!==state.project||edit.snapshot!==JSON.stringify(state.segments)){$('#segmentEditStatus').textContent='句对已变化，请关闭后重新选择。';$('#btnSegmentCommit').disabled=true;return;}
      try {
        const next=structuredClone(state.segments);
        if(edit.mode==='split')next.splice(edit.index,1,...SegmentOps.split(next[edit.index],edit.sourceCut,edit.targetCut,edit.id));
        else next.splice(edit.index,2,SegmentOps.merge(next[edit.index],next[edit.index+1],$('#mergeMode').value));
        $('#dlgSegmentEdit').close();
        await writeAdjustedSegments(next,edit.mode==='split'?'句对已拆分':'相邻句对已合并');
      }catch(error){alert('调整失败：'+error.message);}
    };
    $('#btnPairUndo').onclick=async()=>{
      const entry=state.pairUndo[state.pairUndo.length-1];if(!entry)return;
      if(entry.project!==state.project||entry.after!==JSON.stringify(state.segments)){alert('调整后已有其他编辑。为保护新内容，不覆盖撤销；可手动拆分/合并或查看调整前记录。');return;}
      try {await writeAdjustedSegments(structuredClone(entry.before),'已撤销上一次句对调整',false);state.pairUndo.pop();$('#btnPairUndo').disabled=!state.pairUndo.length;}
      catch(error){alert('撤销失败：'+error.message);}
    };
    const editHistory = new WeakMap();
    function recordEditor(editor, remember = true) {
      const seg = state.segments[+editor.dataset.i];
      const previous = Rich.normalize(seg.tgtRuns, seg.tgt || '');
      const next = Rich.fromDOM(editor);
      if (remember && JSON.stringify(previous) !== JSON.stringify(next.runs)) {
        const h = editHistory.get(editor) || { undo: [], redo: [] };
        h.undo.push(previous); if (h.undo.length > 100) h.undo.shift(); h.redo = [];
        editHistory.set(editor, h);
      }
      seg.tgt = next.text; seg.tgtRuns = next.runs; seg.applied = false;
      saveProjectDebounced();
    }
    function formatEditor(editor, kind) {
      if (!editor || !Rich.applyFormat(editor, kind)) { log('请先选中本段译文中的文字，再设置格式。'); return; }
      recordEditor(editor);
    }
    $('#segments').addEventListener('mousedown', e => {
      if (e.target.closest('[data-format]')) e.preventDefault();
    });
    $('#segments').addEventListener('keydown', e => {
      const editor = e.target.closest('.seg-tgt');
      if (!editor || e.isComposing || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const kind = { b: 'bold', i: 'italic', u: 'underline' }[key];
      if (kind) { e.preventDefault(); formatEditor(editor, kind); }
      if (key === 'z' || key === 'y') {
        e.preventDefault();
        const h = editHistory.get(editor); if (!h) return;
        const redo = key === 'y' || e.shiftKey, from = redo ? h.redo : h.undo, to = redo ? h.undo : h.redo;
        if (!from.length) return;
        to.push(Rich.fromDOM(editor).runs);
        const runs = from.pop(); editor.innerHTML = Rich.toHTML(runs);
        Rich.restoreSelection(editor, Rich.text(runs).length, Rich.text(runs).length);
        recordEditor(editor, false);
      }
    });
    // Never insert clipboard/drop HTML, scripts, images or external attributes.
    function insertPlain(editor, text) {
      const pos = Rich.selectionOffsets(editor);
      if (!pos) { editor.focus(); Rich.restoreSelection(editor, Rich.fromDOM(editor).text.length, Rich.fromDOM(editor).text.length); }
      const selection = window.getSelection(), range = selection.getRangeAt(0);
      range.deleteContents(); const node = document.createTextNode(text.replace(/\r\n?/g, '\n'));
      range.insertNode(node); range.setStartAfter(node); range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range); recordEditor(editor);
    }
    $('#segments').addEventListener('paste', e => {
      const editor = e.target.closest('.seg-tgt'); if (!editor) return;
      e.preventDefault(); insertPlain(editor, (e.clipboardData && e.clipboardData.getData('text/plain')) || '');
    });
    $('#segments').addEventListener('drop', e => {
      if (e.target.closest('.seg-tgt')) { e.preventDefault(); e.stopPropagation(); log('请使用粘贴插入文字，避免拖入不可信富文本。'); }
    });
    $('#segments').addEventListener('input', e => {
      const editor = e.target.closest('.seg-tgt');
      if (editor) recordEditor(editor);
    });
    $('#segments').addEventListener('click', async e => {
      const formatButton = e.target.closest('[data-format]');
      if (formatButton) { formatEditor(formatButton.closest('.seg').querySelector('.seg-tgt'), formatButton.dataset.format); return; }
      const t = e.target;
      if(t.classList.contains('split-seg')||t.classList.contains('merge-seg')){openSegmentEdit(+t.dataset.i,t.classList.contains('split-seg')?'split':'merge');return;}
      if(t.classList.contains('pair-history')){toggleSegExtra(+t.dataset.i,'alignment');return;}
      if (t.classList.contains('confirm-seg')) {
        const i = +t.dataset.i, seg = state.segments[i];
        if (!(seg.tgt || '').trim()) { alert('译文为空。'); return; }
        seg.status = 'translated';
        // 修订留痕：确认即追加版本（V1 初稿，或与上一版文本不同的新版本）
        if (!Array.isArray(seg.revisions)) seg.revisions = [];
        const lastRev = seg.revisions[seg.revisions.length - 1];
        if (!lastRev || !Diff.sameText(lastRev.text, seg.tgt) || JSON.stringify(Rich.normalize(lastRev.runs, lastRev.text)) !== JSON.stringify(Rich.normalize(seg.tgtRuns, seg.tgt))) {
          seg.revisions.push({
            v: 'V' + (seg.revisions.length + 1),
            author: state.author || '译者',
            text: seg.tgt,
            runs: Rich.normalize(seg.tgtRuns, seg.tgt),
            date: new Date().toISOString().slice(0, 10)
          });
          seg.author = seg.author || (state.author || '译者');
        }
        const prev = i > 0 ? state.segments[i - 1] : null;
        const prevNorm = (prev && prev.para != null && seg.para != null && prev.para === seg.para)
          ? Core.normalizeCJK(prev.src) : '';
        await addTmRows([{ src: seg.src, tgt: seg.tgt, note: '译员确认', origin: '工作台', prevNorm }], '入库');
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
      } else if (t.classList.contains('rev-btn') || t.classList.contains('cmt-btn')) {
        toggleSegExtra(+t.dataset.i, t.classList.contains('rev-btn') ? 'rev' : 'cmt');
      } else if (t.classList.contains('cmt-add')) {
        const i = +t.dataset.i;
        const input = document.querySelector('.seg-extra[data-i="' + i + '"] .cmt-input');
        const text = (input && input.value || '').trim();
        if (!text) return;
        const seg = state.segments[i];
        if (!Array.isArray(seg.comments)) seg.comments = [];
        seg.comments.push({ author: state.author || '译者', text, date: new Date().toISOString().slice(0, 10) });
        input.value = '';
        toggleSegExtra(i, 'cmt');
        saveProjectDebounced();
        log('批注已添加。');
      }
    });

    /* 修订记录与批注面板（按需渲染） */
    function toggleSegExtra(i, mode) {
      const box = document.querySelector('.seg-extra[data-i="' + i + '"]');
      if (!box) return;
      const seg = state.segments[i];
      if (!box.hidden && box.dataset.mode === mode) { box.hidden = true; return; }
      box.dataset.mode = mode;
      let h = '';
      if(mode==='alignment'){
        h='<div class="extra-title">调整前原始记录（归档，不冒充新句对的修订）</div>';
        h+=(seg.alignmentHistory||[]).map((old,j)=>`<details><summary>记录 ${j+1} · ${esc((old.src||'').slice(0,45))}</summary><div class="seg-src">${esc(old.src||'')}</div><div class="pair-target">${Rich.toHTML(old.tgtRuns,old.tgt||'')}</div>${(old.revisions||[]).map(r=>`<div class="rev-row">${esc(r.v||'')} · ${esc(r.author||'')} · ${esc(r.date||'')}<div class="pair-target">${Rich.toHTML(r.runs,r.text||'')}</div></div>`).join('')}${(old.comments||[]).map(c=>`<div class="term-note">批注 ${esc(c.author||'')}：${esc(c.text||'')}</div>`).join('')}</details>`).join('');
      } else if (mode === 'rev') {
        const revs = seg.revisions || [];
        h += '<div class="extra-title">修订记录</div>';
        if (revs.length >= 2) {
          const ops = Diff.diffWords(revs[revs.length - 2].text, revs[revs.length - 1].text);
          h += '<div class="diff-line">' + ops.map(o =>
            o.t === 'eq' ? esc(o.text) :
            o.t === 'del' ? '<del>' + esc(o.text) + '</del>' :
            '<ins>' + esc(o.text) + '</ins>').join(' ') + '</div>';
        }
        h += revs.slice().reverse().map(rv =>
          `<div class="rev-row"><b>${esc(rv.v)}</b> · ${esc(rv.author)} · ${esc(rv.date)}<div class="term-note">${esc(rv.text.slice(0, 160))}</div></div>`
        ).join('') || '<div class="empty">尚无修订记录。确认段落时自动生成 V1。</div>';
      } else {
        const cmts = seg.comments || [];
        h += '<div class="extra-title">批注</div>';
        h += cmts.map(c2 => `<div class="rev-row"><b>${esc(c2.author)}</b> · ${esc(c2.date)}<div class="term-note">${esc(c2.text)}</div></div>`).join('')
          || '<div class="empty">暂无批注。</div>';
        h += `<div class="cmt-add-row"><input class="cmt-input" placeholder="添加批注（署名：${esc(state.author || '译者')}）…"><button class="linkbtn cmt-add" data-i="${i}">添加</button></div>`;
      }
      box.innerHTML = h;
      box.hidden = false;
    }

    // match panel: adopt
    $('#matchList').addEventListener('click', e => {
      if (!e.target.classList.contains('use-match')) return;
      const row = e.target.closest('.match-row');
      const idx = parseInt(($('#matchSegIdx').textContent.match(/\d+/) || [0])[0]) - 1;
      const ta = $(`.seg-tgt[data-i="${idx}"]`);
      if (ta) { ta.textContent = row.dataset.tgt; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    });

    // sidebar tabs
    $$('.side-tab').forEach(b => b.onclick = () => switchSide(b.dataset.tab));
    function switchSide(tab) {
      $$('.side-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
      $$('.side-pane').forEach(p => p.style.display = p.dataset.pane === tab ? '' : 'none');
    }
    state.switchSide = switchSide;

    $('#termSearch').oninput = renderTerms;
    // Candidate text is immutable; human decisions are maintained separately.
    let candidateBatch = null, candidatePage = 0, candidateDecisions = [], candidateWorker = null, candidateTimer = null;
    const candidateSnapshot = () => JSON.stringify(state.segments.map(s=>[s.src,s.tgt]));
    function cancelCandidateScan() {
      if(candidateWorker)candidateWorker.terminate(); candidateWorker=null;
      clearTimeout(candidateTimer); candidateTimer=null;
    }
    function renderCandidates() {
      const all=candidateBatch ? candidateBatch.candidates : [], start=candidatePage*50;
      $('#candidateList').innerHTML=all.slice(start,start+50).map((c,j)=>{
        const i=start+j,d=candidateDecisions[i];
        return `<div class="candidate-row" data-candidate="${i}"><label><input type="checkbox" class="candidate-accept" ${d.accept?'checked':''}> ${esc(c.term)} · ${c.freq} 次</label>
          <input type="text" class="candidate-en" aria-label="${esc(c.term)} 的英文译名" maxlength="2000" value="${esc(d.tgt)}" placeholder="填写或确认英文译名">
          <div class="candidate-context">统计候选：${esc((c.translations||[]).map(t=>t.t).join(' / ')||'证据不足，译名留空')}（仅供参考）</div>
          ${(c.contexts||[]).map(ctx=>`<div class="candidate-context">原：${esc(ctx.src)}<br>译：${esc(ctx.tgt)}</div>`).join('')}</div>`;
      }).join('') || '<div class="empty">暂无新候选术语。</div>';
      $('#candidatePage').textContent=`${all.length?candidatePage+1:0} / ${Math.ceil(all.length/50)} 页 · 已选 ${candidateDecisions.filter(d=>d.accept).length}`;
      $('#candidatePrev').disabled=candidatePage===0;
      $('#candidateNext').disabled=start+50>=all.length;
      $('#btnCandidateCommit').disabled=!candidateDecisions.some(d=>d.accept);
    }
    function scanCandidates() {
      cancelCandidateScan(); candidateBatch=null; candidateDecisions=[]; candidatePage=0;renderCandidates();
      const project=state.project,snapshot=candidateSnapshot();
      $('#candidateStatus').textContent='正在扫描全部句段…';
      try {
        const worker=new Worker('js/term-worker.js?v=1.7');candidateWorker=worker;
        const fail=message=>{if(candidateWorker!==worker)return;cancelCandidateScan();$('#candidateStatus').textContent=message;};
        worker.onerror=()=>fail('提取失败。请刷新页面后重试。');
        candidateTimer=setTimeout(()=>fail('扫描超过 60 秒，请拆分项目后重试。'),60000);
        worker.onmessage=e=>{
          if(candidateWorker!==worker)return;cancelCandidateScan();
          if(project!==state.project || snapshot!==candidateSnapshot()){$('#candidateStatus').textContent='工作区已变化，请重新扫描。';return;}
          if(e.data.error){$('#candidateStatus').textContent=e.data.error;return;}
          candidateBatch={...e.data.result,project,snapshot};
          candidateDecisions=candidateBatch.candidates.map(c=>({term:c.term,accept:false,tgt:((c.translations||[])[0]||{}).t||''}));
          const s=candidateBatch.stats;
          $('#candidateStatus').textContent=`已扫描 ${state.segments.length} 段，有效句对 ${s.eligible}，跳过未译/空段 ${s.skipped}，排除已有术语 ${s.existing}，待复核 ${candidateDecisions.length} 条（最多展示前 300 条）。${candidateBatch.warning||''}`;
          renderCandidates();
        };
        worker.postMessage({segments:state.segments.map(s=>({src:s.src,tgt:s.tgt})),existing:state.terms.map(t=>({zh:t.zh})),minFreq:Number($('#candidateMinFreq').value)});
      }catch(error){cancelCandidateScan();$('#candidateStatus').textContent='无法启动本地提取：'+error.message;}
    }
    $('#btnTermExtract').onclick=()=>{$('#dlgTermCandidates').showModal();scanCandidates();};
    $('#btnCandidateScan').onclick=scanCandidates;
    $('#dlgTermCandidates').addEventListener('close',cancelCandidateScan);
    $('#candidateList').addEventListener('input',e=>{
      const row=e.target.closest('[data-candidate]');if(!row)return;
      const d=candidateDecisions[+row.dataset.candidate];
      if(e.target.classList.contains('candidate-accept'))d.accept=e.target.checked;
      if(e.target.classList.contains('candidate-en'))d.tgt=e.target.value;
      $('#btnCandidateCommit').disabled=!candidateDecisions.some(d=>d.accept);
      $('#candidatePage').textContent=`${candidatePage+1} / ${Math.ceil(candidateDecisions.length/50)} 页 · 已选 ${candidateDecisions.filter(d=>d.accept).length}`;
    });
    $('#candidatePrev').onclick=()=>{if(candidatePage>0){candidatePage--;renderCandidates();}};
    $('#candidateNext').onclick=()=>{if((candidatePage+1)*50<candidateDecisions.length){candidatePage++;renderCandidates();}};
    $('#btnCandidateDecisions').onclick=()=>{
      if(!candidateBatch)return;
      const result=window.MiniCatTermEngine.validateDecisions(candidateDecisions,candidateBatch.candidates);
      if(!result.valid){alert(result.errors.join('；'));return;}
      IO.download('decisions.json',JSON.stringify(candidateDecisions,null,2),'application/json');
      IO.download('candidates.json',JSON.stringify({candidates:candidateBatch.candidates},null,2),'application/json');
    };
    $('#btnCandidateCommit').onclick=async()=>{
      if(!candidateBatch)return;
      if(candidateBatch.project!==state.project || candidateBatch.snapshot!==candidateSnapshot()){$('#candidateStatus').textContent='工作区已变化，请重新扫描后复核。';$('#btnCandidateCommit').disabled=true;return;}
      try {
        const rows=window.MiniCatCandidates.acceptedRows(candidateBatch.candidates,candidateDecisions);
        if(!rows.length)return;
        $('#btnCandidateCommit').disabled=true;
        const count=await withWorkspaceLocked(()=>addTermRows(rows));
        $('#dlgTermCandidates').close();renderStats();log(`已将 ${count} 条人工确认术语整理入当前项目术语表，可导出 CSV/TBX；重复项不覆盖。`);
      }catch(error){$('#candidateStatus').textContent=error.message;$('#btnCandidateCommit').disabled=false;}
    };
    $('#termList').addEventListener('click', e => {
      const btn = e.target.closest('.webref-go');
      if (!btn) return;
      const term = state.terms.find(t => String(t.id) === String(btn.dataset.id));
      if (!term) return;
      state.webrefTerm = term;
      $('#webrefInput').value = term.zh;
      switchSide('webref');
      runWebRef();
    });
    $('#concordInput').oninput = e => runConcordance(e.target.value.trim());

    /* ---- 联网查阅（多源参考；译文列绝不自动写入，采纳须人工点击） ---- */
    function webrefRender(data, keyword) {
      const box = $('#webrefList');
      const term = state.webrefTerm;
      let h = '';
      for (const g of data.results) {
        const badge = g.error
          ? `<span class="src-badge fail">无法访问</span>`
          : `<span class="src-badge">${g.hits.length} 条</span>`;
        h += `<div class="src-card"><div class="src-head"><b>${esc(g.source)}</b>${badge}</div>`;
        if (g.error) h += `<div class="term-note">${g.source.includes('大都会') ? 'Met 接口不可用（官方已宣布旧搜索接口 2026-10-01 停用，迁移期间可能间歇失败）——' : '网络受限或超时——'}请用下方直达链接。</div>`;
        if (!g.error && g.hits.length && g.hits.some(h2 => h2.exact === false) && !g.hits.some(h2 => h2.exact === true)) {
          h += `<div class="term-note">该来源无精确匹配条目——可尝试下方 Google / 站内直达链接。</div>`;
        }
        for (const hit of g.hits.slice(0, 5)) {
          const meta = [hit.date, hit.culture, hit.medium, hit.year && (hit.year + '年'), hit.creator, hit.highlight ? '⭐ 馆方高亮藏品' : '']
            .filter(Boolean).map(x => esc(String(x))).join(' · ');
          const enish = typeof hit.title === 'string' ? hit.title : '';
          const relBadge = hit.exact === undefined ? '' :
            `<span class="src-badge ${hit.exact ? '' : 'related'}">${hit.exact ? '精确' : '相关'}</span>`;
          h += `<div class="hit-row">
            <a class="hit-title" href="${esc(hit.url)}" target="_blank" rel="noopener noreferrer">${esc(hit.title)}</a>${relBadge}
            ${hit.snippet ? `<div class="term-note">${esc(hit.snippet.slice(0, 160))}</div>` : ''}
            ${meta ? `<div class="term-note">${meta}</div>` : ''}
            ${term ? `<div class="adopt-btns">
              <button class="linkbtn adopt-note" data-src="${esc(g.source)}" data-text="${esc((hit.snippet || hit.medium || hit.title || '').slice(0, 200))}">引用到备注</button>
              ${/metmuseum|Wikipedia/i.test(g.source) && enish ? `<button class="linkbtn adopt-en" data-src="${esc(g.source)}" data-en="${esc(enish)}">设为英文译法（人工确认）</button>` : ''}
            </div>` : ''}
          </div>`;
        }
        h += `</div>`;
      }
      h += `<div class="src-card"><div class="src-head"><b>权威直达链接</b></div><div class="webref-links">` +
        data.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer" title="${esc(l.note || '')}">${esc(l.name)}</a>`).join('') +
        `</div></div>`;
      h += `<div class="term-note compliance-note">⚠️ 查阅结果仅作翻译参考。依据国社科申报要求，工具不会自动生成或写入译文；英文译法须经你人工确认后点击「设为英文译法」才会记入术语库，并注明来源与日期。</div>`;
      box.innerHTML = h;
    }

    async function runWebRef() {
      const request = ++state.webrefRequest;
      const project = state.project;
      const kw = ($('#webrefInput').value || '').trim();
      const status = $('#webrefStatus');
      status.textContent = '';
      $('#webrefList').innerHTML = '';
      if (!kw) { $('#webrefList').innerHTML = '<div class="empty">输入关键词后按回车查阅。</div>'; return; }
      const term = state.webrefTerm;
      const isCJK = /[一-鿿]/.test(kw);
      const zhTerm = isCJK ? kw : (term ? term.zh : '');
      let enTerm = !isCJK ? kw : (($('#webrefEn').checked && term && term.en) ? term.en : '');
      status.textContent = '正在抓取：维基百科 / 大都会博物馆 / 书目…';
      try {
        const data = await Web.lookupAll(zhTerm, enTerm, { met: !!enTerm, archive: !!enTerm });
        if (request !== state.webrefRequest || project !== state.project) return;
        status.textContent = '';
        webrefRender(data, kw);
      } catch (err) {
        if (request !== state.webrefRequest || project !== state.project) return;
        status.textContent = '';
        $('#webrefList').innerHTML = `<div class="empty">抓取失败：${esc(err.message || '')}。请使用直达链接。</div>`;
      }
    }
    $('#webrefInput').addEventListener('keydown', e => { if (e.key === 'Enter') runWebRef(); });
    $('#webrefInput').addEventListener('input', () => {
      state.webrefRequest++;
      state.webrefTerm = null;
      $('#webrefStatus').textContent = '';
      $('#webrefList').innerHTML = '<div class="empty">按回车搜索新关键词。</div>';
    });
    $('#webrefEn').addEventListener('change', runWebRef);

    $('#webrefList').addEventListener('click', async e => {
      const noteBtn = e.target.closest('.adopt-note');
      const enBtn = e.target.closest('.adopt-en');
      if (!noteBtn && !enBtn) return;
      const term = state.webrefTerm;
      if (!term) { alert('请先从术语库点 🌐 进入查阅，再采纳。'); return; }
      const fresh = (await DB.Terms.all(state.project)).find(t2 => String(t2.id) === String(term.id));
      if (!fresh) { alert('术语已不存在。'); return; }
      const stamp = today();
      if (enBtn) {
        fresh.en = enBtn.dataset.en;
        fresh.note = (fresh.note ? fresh.note + '｜' : '') + `[人工采纳译名·${enBtn.dataset.src} ${stamp}]`;
      } else {
        fresh.note = (fresh.note ? fresh.note + '｜' : '') + `[网络参考·${noteBtn.dataset.src} ${stamp}] ${noteBtn.dataset.text}`;
      }
      await DB.Terms.addMany([fresh]);
      state.terms = await DB.Terms.all(state.project);
      await renderTerms();
      renderSegments();
      log(`术语「${fresh.zh}」${enBtn ? '英文译名已人工采纳' : '备注已引用网络来源'}。`);
    });

    // toolbar
    $('#btnImportSource').onclick = () => $('#dlgSource').showModal();
    $('#btnImportRevision').onclick = async () => {
      // 修订人/版本留空 = 自动识别（Word 修订署名/文件属性 + 自动编号），避免上次输入残留
      $('#revAuthor').value = '';
      $('#revLabel').value = '';
      $('#revFile').value = '';
      $('#revPreview').innerHTML = '<div class="empty">选择文件后自动与当前项目句段匹配；修订人与日期将从 Word 修订记录/文件属性自动识别。</div>';
      $('#btnRevCommit').disabled = true;
      $('#dlgRevision').showModal();
    };
    $('#btnSettings').onclick = async () => { $('#setAuthor').value = state.author || ''; $('#dlgSettings').showModal(); };
    $('#btnSetSave').onclick = async () => {
      state.author = $('#setAuthor').value.trim();
      await DB.Meta.set('authorName', state.author);
      $('#dlgSettings').close();
      log('署名已设置：' + (state.author || '（空）'));
    };
    $('#btnImportTM').onclick = () => { prepareTmDialog(); $('#dlgTM').showModal(); };
    $('#btnImportTerms').onclick = () => $('#dlgTerms').showModal();
    $('#btnExport').onclick = () => $('#dlgExport').showModal();
    $('#btnRematch').onclick = async () => { await rematchAll(); log('已重新匹配。'); };
    $('#btnWipe').onclick = async () => {
      if (!confirm(`清空项目「${state.project}」的句段工作区？（记忆库和术语库不受影响）`)) return;
      state.segments = [];
      await saveProjectNow();
      renderSegments(); renderStats();
    };
    $('#btnConflictReload').onclick = () => location.reload();
    $('#btnConflictForce').onclick = async () => {
      const pc = state.pendingConflict;
      if (!pc) return;
      const r = await DB.Projects.saveWithRev(pc.name, null, { segments: pc.segments, updated: new Date().toISOString() });
      if (r && r.ok) { state.rev = r.newRev; projectedRev = r.newRev; state.pendingConflict = null; $('#conflictBanner').style.display = 'none'; log('已按你的选择强制覆盖其他标签页的内容。'); }
    };
    $('#btnTabLockDismiss').onclick = () => { const b = $('#tabLockBanner'); if (b) b.style.display = 'none'; };
    window.addEventListener('pagehide', () => { if (releaseProjectLock) { const f = releaseProjectLock; releaseProjectLock = null; f(); } });
    $('#btnBackup').onclick = exportBackup;
    $('#fileRestore').onchange = restoreBackup;
    $('#btnMT').onclick = applyMt;
    $('#btnBannerBackup').onclick = exportBackup;
    $('#btnBannerDismiss').onclick = hideBackupBanner;
    setupDragDrop();
    (async () => {
      // show the MT button whenever the API exists and zh→en is not ruled out;
      // actual model availability errors surface on click
      try {
        if (!('Translator' in self) || !self.Translator || !self.Translator.availability) { $('#btnMT').style.display = 'none'; return; }
        const a = await self.Translator.availability({ sourceLanguage: 'zh', targetLanguage: 'en' });
        if (a === 'unavailable') $('#btnMT').style.display = 'none';
      } catch (e) { $('#btnMT').style.display = 'none'; }
    })();
    checkBackupReminder();

    /* ---- dialogs ---- */
    // source
    $('#srcSegMode').onchange = e => {};
    $('#btnSourceLoad').onclick = async () => {
      const f = $('#srcFile').files[0];
      let text = '';
      if (f && /\.docx$/i.test(f.name)) {
        setBusy(true, '正在读取 Word 文档…');
        try {
          const buf = await f.arrayBuffer();
          const { paragraphs } = await Office.docxToBlocks(buf);
          text = paragraphs.filter(p => p.trim()).join('\n');
        } catch (err) { setBusy(false); alert('docx 解析失败：' + err.message); return; }
        setBusy(false);
      } else {
        text = f ? await IO.readAsText(f) : $('#srcPaste').value;
      }
      if (!text.trim()) { alert('请选择文件或粘贴文本。'); return; }
      $('#dlgSource').close();
      await importSourceText(text, $('#srcSegMode').value);
    };

    // TM
    function prepareTmDialog() { $('#tmPasteSrc').value = ''; $('#tmPasteTgt').value = ''; $('#tmFile').value = ''; $('#tmMappingBox').innerHTML = ''; delete $('#tmMappingBox').dataset.rows; delete $('#tmMappingBox').dataset.tus; delete $('#tmMappingBox').dataset.pairs; }

    function showTablePreview(header, rows, mapping) {
      if (mapping.src < 0 || mapping.tgt < 0 || mapping.src === mapping.tgt) {
        $('#tmMappingBox').innerHTML = '<div class="mapping-note">⚠️ 未识别出中文/译文列，请改用 TMX/JSONL 或粘贴方式。</div>';
        return false;
      }
      $('#tmMappingBox').innerHTML = `<div class="mapping-note">表格：源列=<b>${esc(header[mapping.src])}</b>，译文列=<b>${esc(header[mapping.tgt])}</b>，共 ${rows.length} 行。预览：</div>` +
        rows.slice(0, 5).map(r => `<div class="mapping-row"><span>${esc(String(r[mapping.src] || '').slice(0, 40))}</span><span>${esc(String(r[mapping.tgt] || '').slice(0, 40))}</span></div>`).join('');
      $('#tmMappingBox').dataset.rows = JSON.stringify({ header, rows: rows.slice(0, 20000), mapping });
      return true;
    }

    async function previewXlsxTm(f) {
      const sheets = await Office.xlsxToSheets(await f.arrayBuffer());
      const sheet = sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
      const header = (sheet.rows[0] || []).map(h => String(h || '').trim());
      const rows = sheet.rows.slice(1).filter(r => r.some(c => String(c || '').trim()));
      const okp = showTablePreview(header, rows, IO.mapBilingualHeader(header));
      if (okp) $('#tmMappingBox').dataset.note = `xlsx 工作表「${sheet.name}」`;
      return okp;
    }

    async function previewDocxTm(f, mode) {
      const { paragraphs, tables } = await Office.docxToBlocks(await f.arrayBuffer());
      const usable = tables.filter(t => t.rows.length >= 2 && Math.max(...t.rows.map(r => r.length)) >= 2);
      // table path (auto prefers tables — they are unambiguous, e.g. 左右对照表)
      if ((mode === 'auto' || mode === 'table') && usable.length) {
        const allRows = [];
        let header = null, mapping = null;
        for (const t of usable) {
          let body = t.rows;
          const first = t.rows[0].map(c => String(c || '').trim().toLowerCase());
          const looksHeader = first.some(c => /中文|英文|原文|译文|source|target|^id$/.test(c));
          if (looksHeader) {
            if (!header) { header = t.rows[0].map(c => String(c || '').trim()); mapping = Office.sniffDocxTable(t.rows); }
            body = t.rows.slice(1);
          } else if (!header) {
            header = t.rows[0].map((_, i2) => '列' + (i2 + 1));
          }
          allRows.push(...body);
        }
        if (!mapping && header) mapping = Office.sniffDocxTable([header, ...allRows.slice(0, 10)]);
        if (mapping && allRows.length) {
          const m = { src: mapping.srcCol, tgt: mapping.tgtCol, note: -1, id: mapping.idCol };
          const okp = showTablePreview(header.length ? header : allRows[0].map((_, i2) => '列' + (i2 + 1)), allRows, m);
          if (okp) $('#tmMappingBox').dataset.note = `docx 表格 ×${usable.length}`;
          return okp;
        }
      }
      // paragraph path
      const sniffed = Office.sniffDocxParagraphs(paragraphs);
      if ((mode === 'auto') && sniffed) {
        $('#tmMappingBox').innerHTML = `<div class="mapping-note">docx 段落（${sniffed.mode === 'alternate' ? '中英交替' : '先中后英'}）：<b>${sniffed.pairs.length}</b> 对${sniffed.mismatch ? `，尾部落单 ${sniffed.mismatch} 段` : ''}。预览：</div>` +
          sniffed.pairs.slice(0, 5).map(p => `<div class="mapping-row"><span>${esc(p.src.slice(0, 40))}</span><span>${esc(p.tgt.slice(0, 40))}</span></div>`).join('');
        $('#tmMappingBox').dataset.pairs = JSON.stringify(sniffed.pairs.slice(0, 20000));
        return true;
      }
      if (mode === 'alternate' || mode === 'zh_then_en') {
        const ps = paragraphs.map(p => p.trim()).filter(Boolean);
        let pairs;
        if (mode === 'alternate') {
          pairs = [];
          for (let i = 0; i + 1 < ps.length; i += 2) pairs.push({ src: ps[i], tgt: ps[i + 1] });
        } else {
          const flags = ps.map(Office.isCJK);
          let best = 0, bestScore = -1;
          for (let i = 0; i <= ps.length; i++) {
            let zhBefore = 0, enAfter = 0;
            for (let j = 0; j < i; j++) if (flags[j]) zhBefore++;
            for (let j = i; j < ps.length; j++) if (!flags[j]) enAfter++;
            if (zhBefore + enAfter > bestScore) { bestScore = zhBefore + enAfter; best = i; }
          }
          const zh = ps.slice(0, best), en = ps.slice(best);
          const n = Math.min(zh.length, en.length);
          pairs = zh.slice(0, n).map((s, k) => ({ src: s, tgt: en[k] }));
        }
        $('#tmMappingBox').innerHTML = `<div class="mapping-note">docx 段落（手动模式）：<b>${pairs.length}</b> 对。预览：</div>` +
          pairs.slice(0, 5).map(p => `<div class="mapping-row"><span>${esc(p.src.slice(0, 40))}</span><span>${esc(p.tgt.slice(0, 40))}</span></div>`).join('');
        $('#tmMappingBox').dataset.pairs = JSON.stringify(pairs.slice(0, 20000));
        return true;
      }
      $('#tmMappingBox').innerHTML = '<div class="mapping-note">⚠️ 未能自动识别双语结构。请在「docx 结构」中选择模式，或使用粘贴方式。</div>';
      return false;
    }

    $('#tmFile').onchange = async () => {
      const f = $('#tmFile').files[0]; if (!f) return;
      $('#tmMappingBox').innerHTML = '<div class="mapping-note">解析中…</div>';
      delete $('#tmMappingBox').dataset.rows;
      delete $('#tmMappingBox').dataset.tus;
      delete $('#tmMappingBox').dataset.pairs;
      try {
        const mode = $('#tmDocxMode') ? $('#tmDocxMode').value : 'auto';
        if (/\.docx$/i.test(f.name)) { await previewDocxTm(f, mode); return; }
        if (/\.xlsx$/i.test(f.name)) { await previewXlsxTm(f); return; }
        const text = await IO.readAsText(f);
        if (/\.jsonl$/i.test(f.name)) {
          const objs = IO.parseJSONL(text);
          const rows = objs
            .filter(o => o && typeof o === 'object' && (o.zh || o.src) && (o.en || o.tgt))
            .map(o => [String(o.zh || o.src || ''), String(o.en || o.tgt || ''), String(o.note || o.chapter || '')]);
          if (!rows.length) { $('#tmMappingBox').innerHTML = '<div class="mapping-note">JSONL 中没有可导入的 zh/en 句对。</div>'; return; }
          showTablePreview(['中文', '英文', '备注'], rows, { src: 0, tgt: 1, note: 2 });
          $('#tmMappingBox').dataset.note = 'JSONL';
          return;
        }
        if (/<tmx[\s>]/i.test(text.slice(0, 400))) {
          const { tus } = IO.parseTMX(text);
          $('#tmMappingBox').innerHTML = `<div class="mapping-note">TMX：${tus.length} 个翻译单元，预览前 5 条：</div>` +
            tus.slice(0, 5).map(tu => `<div class="mapping-row"><span>${esc(tu.src.slice(0, 40))}</span><span>${esc(tu.tgt.slice(0, 40))}</span></div>`).join('');
          $('#tmMappingBox').dataset.tus = JSON.stringify(tus.slice(0, 20000));
        } else {
          const { header, rows, mapping } = IO.sniffBilingualTable(text);
          showTablePreview(header, rows, mapping);
        }
      } catch (err) { $('#tmMappingBox').innerHTML = `<div class="mapping-note">解析失败：${esc(err.message)}</div>`; }
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
      await saveProjectNow();
      await rematchAll();
    };

    // terms
    $('#termFile').onchange = async () => {
      const f = $('#termFile').files[0]; if (!f) return;
      $('#termMappingBox').innerHTML = '<div class="mapping-note">解析中…</div>';
      try {
        let rows;
        if (/\.xlsx$/i.test(f.name)) {
          const sheets = await Office.xlsxToSheets(await f.arrayBuffer());
          const sheet = sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
          const header = (sheet.rows[0] || []).map(h => String(h || '').trim());
          const mapping = IO.mapBilingualHeader(header);
          refineTermMapping(header, mapping);
          if (mapping.src < 0) { alert('未识别出中文术语列（表头：' + header.join(' / ') + '）。'); return; }
          const fallbackIdx = header.findIndex(h => h.includes('2025'));
          rows = sheet.rows.slice(1)
            .filter(r => r.some(c => String(c || '').trim()))
            .map(r => ({
              zh: String(r[mapping.src] || '').trim(),
              en: (mapping.tgt >= 0 ? String(r[mapping.tgt] || '').trim() : '') || (fallbackIdx >= 0 ? String(r[fallbackIdx] || '').trim() : ''),
              note: mapping.note >= 0 ? String(r[mapping.note] || '').trim() : ''
            }));
        } else {
          const text = await IO.readAsText(f);
          if (/<martif/i.test(text.slice(0, 400))) {
            rows = IO.parseTBX(text);
          } else {
            const { header, rows: tableRows, mapping } = IO.sniffBilingualTable(text);
            refineTermMapping(header, mapping);
            if (mapping.src < 0) { alert('未识别出中文术语列。'); return; }
            const fallbackIdx = header.findIndex(h => h.includes('2025'));
            rows = tableRows.map(r => ({
              zh: r[mapping.src], en: (mapping.tgt >= 0 ? (r[mapping.tgt] || '').trim() : '') || (fallbackIdx >= 0 ? (r[fallbackIdx] || '').trim() : ''),
              note: [mapping.note >= 0 ? r[mapping.note] : '', mapping.id >= 0 ? '' : ''].filter(Boolean).join('｜')
            }));
          }
        }
        rows = rows.filter(t => String(t.zh || '').trim());
        $('#termMappingBox').innerHTML = `<div class="mapping-note">解析到 <b>${rows.length}</b> 条术语，预览：</div>` +
          rows.slice(0, 6).map(t => `<div class="mapping-row"><span>${esc(String(t.zh || '').slice(0, 24))}</span><span>${esc(String(t.en || '').slice(0, 40))}</span></div>`).join('');
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
    /* 文档交付：范围可选；纯译文按 seg.para 重建段落 */
    function exportSegs() {
      return $('#expRange').value === 'all'
        ? state.segments.slice()
        : state.segments.filter(s => s.status === 'translated');
    }
    function paragraphsFromSegs(segs, zhSide) {
      // rebuild paragraphs: consecutive segments of the same para joined (EN with spaces)
      const out = [];
      const positions=new Map(state.segments.map((segment,index)=>[segment,index]));
      let cur = null;
      for (const s of segs) {
        const t = zhSide ? (s.src || '') : (s.tgt || '');
        if (cur === null || s.para == null || s.para !== cur.para) {
          cur = { para: s.para, parts: [], runs: [], last: null, lastIndex: null };
          out.push(cur);
        }
        if(cur.last&&positions.get(s)!==cur.lastIndex+1)cur.last={...cur.last,joinNext:false};
        if (t) {
          const separator=cur.parts.length&&!zhSide?SegmentOps.targetSeparator(cur.last,s):'';
          if(separator){cur.parts.push(separator);cur.runs.push({text:separator});}
          cur.parts.push(t);
          cur.runs.push(...Rich.normalize(zhSide ? null : s.tgtRuns, t));
        }
        if(t)cur.last=s;
        else if(cur.last)cur.last={...cur.last,joinNext:cur.last.joinNext===true&&s.joinNext===true};
        cur.lastIndex=positions.get(s);
      }
      return out.map(p => ({ para: p.para, text: p.parts.join(''), runs: Rich.normalize(p.runs) }));
    }
    function docxBlocksTitle(sub) {
      return [{ type: 'h1', text: state.project }, { type: 'p', text: sub, italic: true, gray: true }];
    }
    $('#btnDocPure').onclick = () => {
      const paras = paragraphsFromSegs(exportSegs(), false);
      const blocks = docxBlocksTitle(`纯译文 · ${today()}`)
        .concat(paras.map(p => ({ type: 'p', text: p.text || '（待译）', runs: p.runs })));
      IO.download(`纯译文_${state.project}_${today()}.docx`, Write.buildDocx(blocks), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    };
    $('#btnDocPureTxt').onclick = () => {
      const paras = paragraphsFromSegs(exportSegs(), false);
      const txt = paras.map(p => p.text || '（待译）').join('\n\n');
      IO.download(`纯译文_${state.project}_${today()}.txt`, txt || '(无已译段落)', 'text/plain;charset=utf-8');
    };
    $('#btnBiParaDocx').onclick = () => {
      const segs = exportSegs();
      const blocks = docxBlocksTitle(`中英对照 · ${today()}`);
      for (const s of segs) {
        blocks.push({ type: 'p', text: s.src, bold: false });
        blocks.push({ type: 'p', text: s.tgt || '（待译）', runs: Rich.normalize(s.tgtRuns, s.tgt || '（待译）') });
      }
      IO.download(`中英对照_${state.project}_${today()}.docx`, Write.buildDocx(blocks), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    };
    $('#btnSentDocx').onclick = () => {
      const segs = exportSegs();
      const rows = segs.map((s, i) => [i + 1, s.src, { text: s.tgt || '', runs: Rich.normalize(s.tgtRuns, s.tgt || '') }]);
      const blocks = docxBlocksTitle(`句句对照 · ${today()}`)
        .concat([{ type: 'table', header: ['序号', '中文原文', '英文译文'], rows }]);
      IO.download(`句句对照_${state.project}_${today()}.docx`, Write.buildDocx(blocks), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    };
    $('#btnSentXlsx').onclick = () => {
      const segs = exportSegs();
      const rows = [['序号', '中文原文', '英文译文', '匹配率', '状态']]
        .concat(segs.map((s, i) => [i + 1, s.src, s.tgt || '', s.bestScore || 0, s.status === 'translated' ? '已译' : '未译']));
      IO.download(`句句对照_${state.project}_${today()}.xlsx`, Write.buildXlsx([{ name: '句句对照', rows }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    };
    $('#btnSentCsv').onclick = () => {
      const segs = exportSegs();
      const rows = [['序号', '中文原文', '英文译文', '匹配率', '状态']]
        .concat(segs.map((s, i) => [i + 1, s.src, s.tgt || '', s.bestScore || 0, s.status === 'translated' ? '已译' : '未译']));
      IO.download(`句句对照_${state.project}_${today()}.csv`, IO.buildDelimited(rows, ','), 'text/csv;charset=utf-8');
    };
    $('#btnExpTrkDocx').onclick = () => {
      const blocks = [{ type: 'h1', text: `修订痕迹 — ${state.project}` }, { type: 'p', text: `导出于 ${today()} · Word 修订模式（审阅 → 修订 可逐条接受/拒绝）`, italic: true, gray: true }];
      const comments = [];
      let n = 0;
      const withHistory = state.segments.filter(sg => (sg.revisions && sg.revisions.length >= 1) && ((sg.revisions.length >= 2) || (sg.comments && sg.comments.length)));
      if (!withHistory.length) { alert('当前项目中没有带修订记录或批注的段落。\n修订在确认段落或导入修订时自动生成。'); return; }
      for (const seg of withHistory) {
        const revs = seg.revisions;
        const last = revs[revs.length - 1];
        const prev = revs.length >= 2 ? revs[revs.length - 2] : null;
        blocks.push({ type: 'p', text: seg.src, bold: true, size: 21 });
        if (prev) {
          const oldRuns=Rich.normalize(prev.runs,prev.text),newRuns=Rich.normalize(last.runs,last.text);
          const formatted=[...oldRuns,...newRuns].some(r=>r.bold||r.italic||r.underline||r.superscript||r.subscript);
          blocks.push(formatted
            ? {type:'trk',previous:{text:prev.text,runs:oldRuns},current:{text:last.text,runs:newRuns},author:last.author,date:last.date+'T00:00:00Z'}
            : { type: 'trk', ops: Diff.diffWords(prev.text, last.text), author: last.author, date: last.date + 'T00:00:00Z' });
        } else {
          blocks.push({ type: 'p', text: last.text, runs: Rich.normalize(last.runs, last.text) });
        }
        const chain = revs.map(rv => `${rv.v} ${rv.author} ${rv.date}`).join(' → ');
        const cmts = seg.comments || [];
        const cmIdx = [];
        for (const c of cmts) { comments.push({ id: n, author: c.author, date: (c.date || today()) + 'T00:00:00Z', text: c.text }); cmIdx.push(n); n++; }
        blocks.push({ type: 'p', text: chain + (cmts.length ? `｜批注 ${cmts.length} 条` : ''), italic: true, gray: true, size: 18, comments: cmIdx });
      }
      IO.download(`修订痕迹_${state.project}_${today()}.docx`, Write.buildDocx(blocks, { comments }), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      log(`修订痕迹导出：${withHistory.length} 段、批注 ${comments.length} 条。`);
    };
    $('#btnExpRevXlsx').onclick = () => {
      const rows = [['序号', '中文原文', '初版译文', '最新译文', '版本链', '修订人', '批注']]
        .concat(state.segments.map((s2, i) => {
          const revs = s2.revisions || [];
          const first = revs[0] ? revs[0].text : (s2.tgt || '');
          const last = revs.length ? revs[revs.length - 1] : null;
          return [i + 1, s2.src, first, s2.tgt || '',
            revs.map(rv => rv.v + '(' + rv.author + ')').join('→') || '—',
            last ? last.author : '', (s2.comments || []).map(c2 => c2.author + ':' + c2.text).join('；')];
        }));
      IO.download(`修订对照_${state.project}_${today()}.xlsx`, Write.buildXlsx([{ name: '修订对照', rows }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    };
    $('#btnExpRevCsv').onclick = () => {
      const rows = [['序号', '中文原文', '初版译文', '最新译文', '版本链', '修订人', '批注']]
        .concat(state.segments.map((s2, i) => {
          const revs = s2.revisions || [];
          const last = revs.length ? revs[revs.length - 1] : null;
          return [i + 1, s2.src, revs[0] ? revs[0].text : (s2.tgt || ''), s2.tgt || '',
            revs.map(rv => rv.v + '(' + rv.author + ')').join('→') || '—',
            last ? last.author : '', (s2.comments || []).map(c2 => c2.author + ':' + c2.text).join('；')];
        }));
      IO.download(`修订对照_${state.project}_${today()}.csv`, IO.buildDelimited(rows, ','), 'text/csv;charset=utf-8');
    };
    $('#btnExpBilingual').onclick = () => {
      const rows = [['#', '状态', '匹配', '中文', '英文']]
        .concat(exportSegs().map((s, i) => [i + 1, s.status === 'translated' ? '已译' : '未译', s.bestScore || 0, s.src, { text: s.tgt || '', runs: Rich.normalize(s.tgtRuns, s.tgt || '') }]));
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
      await saveProjectNow(); // 防抖中的最后编辑先落库，再快照
      const all = { version: 1, exported: new Date().toISOString(), projects: await DB.Projects.all(), tm: await DB.TM.all(), terms: await DB.Terms.all() };
      IO.download(`mini-cat备份_${today()}.json`, JSON.stringify(all, null, 1), 'application/json');
      await DB.Meta.set('lastBackupAt', Date.now());
      hideBackupBanner();
    }
    async function restoreFromJsonText(text) {
      let raw;
      try { raw = JSON.parse(text); }
      catch (e) { throw new Error('备份不是有效 JSON：' + e.message); }
      // 消毒：结构校验、去外来 ID（防跨库覆盖）、长度封顶、重算派生字段
      const clean = IO.sanitizeBackup(raw, { defaultProject: state.project });
      const allTm = await DB.TM.all();
      const allTerms = await DB.Terms.all();
      const tmKeys = new Set(allTm.map(e => e.project + '\u0000' + e.srcNorm + '\u0000' + e.tgt));
      const termKeys = new Set(allTerms.map(t2 => t2.project + '\u0000' + t2.zh));
      const newTm = clean.tm.filter(r => !tmKeys.has(r.project + '\u0000' + r.srcNorm + '\u0000' + r.tgt));
      const newTerms = clean.terms.filter(r => !termKeys.has(r.project + '\u0000' + r.zh));
      const skipped = (clean.tm.length - newTm.length) + (clean.terms.length - newTerms.length);
      if (!confirm(`恢复备份（消毒后）：记忆 ${newTm.length} 条、术语 ${newTerms.length} 条、项目 ${clean.projects.length} 个。\n合并策略：记忆/术语去重后合并（跳过 ${skipped} 条重复），同名项目的工作区以备份为准。\n继续？`)) return;
      await withWorkspaceLocked(async () => {
        await saveProjectNow();
        await DB.TM.addMany(newTm);
        await DB.Terms.addMany(newTerms);
        for (const p of clean.projects) await DB.Projects.put(p);
        state.projects = (await DB.Projects.all()).map(p => p.name);
        await refreshAll();
        await rematchAll();
      });
      log(`备份恢复完成：新增记忆 ${newTm.length}、新增术语 ${newTerms.length}（跳过重复 ${skipped}）。`);
    }
    async function restoreBackup(e) {
      const f = e.target.files[0]; if (!f) return;
      try { await restoreFromJsonText(await IO.readAsText(f)); }
      catch (err) { alert('恢复失败：' + err.message); }
    }

    /* ---- 导入修订（审校留痕）：按中文源文匹配，文本变化即追加版本 ---- */
    function revParsePairs(f) {
      return Promise.resolve().then(async () => {
        if (/\.docx$/i.test(f.name)) {
          const parsed = await Office.docxToBlocks(await f.arrayBuffer());
          const t = parsed.tables.find(t2 => t2.rows.length >= 1 && t2.rows[0].length >= 2);
          if (t) {
            // 首行若本身携带 Word 修订标记，则它是数据行而非表头
            const firstRowTracked = (t.rowTracked || []).some(x => x.row === 0);
            const header = firstRowTracked ? t.rows[0].map((_, i2) => '列' + (i2 + 1)) : t.rows[0].map(c2 => String(c2 || '').trim());
            const dataRows = firstRowTracked ? t.rows : t.rows.slice(1);
            const sniff = Office.sniffDocxTable([header, ...dataRows.slice(0, 10)]);
            if (sniff) {
              const pairs = [], comments = [];
              dataRows.forEach((r, ri) => {
                const zh = String(r[sniff.srcCol] || ''), en = String(r[sniff.tgtCol] || '');
                if (!zh.trim() && !en.trim()) return;
                // 自动识别：Word 修订模式携带的修订人与时间
                const trk = (t.rowTracked || []).find(x => x.row === (firstRowTracked ? ri : ri + 1) && x.col === sniff.tgtCol);
                const pairIndex = pairs.length;
                const cr = (t.cellRuns || []).find(x => x.row === dataRow && x.col === sniff.tgtCol);
                pairs.push({ zh, en, author: trk ? trk.author : undefined, date: trk ? trk.date : undefined, runs: cr ? cr.runs : undefined });
                // 自动识别：Word 批注（导师/专家意见）
                (t.rowComments || []).filter(rc => rc.row === (firstRowTracked ? ri : ri + 1) && rc.col === sniff.tgtCol).forEach(rc => {
                  rc.ids.forEach(id => {
                    const c2 = (parsed.comments || []).find(cc => String(cc.id) === String(id));
                    if (c2 && c2.text) comments.push({ pairIndex, zh, author: c2.author, date: c2.date, text: c2.text });
                  });
                });
              });
              return { pairs, comments, meta: parsed.meta, note: 'docx 表格' };
            }
          }
          // 无表格 → 尝试段落模式
          const nonEmpty = parsed.paragraphs.filter(p2 => p2.trim());
          const hasCJK = nonEmpty.some(p2 => /[一-鿿]/.test(p2));
          if (hasCJK) {
            // 逐段交替（中文段 + 英文段交替出现）
            const sniff = Office.sniffDocxParagraphs(parsed.paragraphs);
            if (sniff && sniff.pairs.length) {
              return { pairs: sniff.pairs.map(p2 => ({ zh: p2.zh, en: p2.en })), comments: [], meta: parsed.meta, note: 'docx 段落（' + sniff.mode + '）' };
            }
            // 纯英文提取（过滤掉中文段落，保留英文段）
            const enOnly = nonEmpty.filter(p2 => !/[一-鿿]/.test(p2));
            if (enOnly.length > 0 && enOnly.length < nonEmpty.length) {
              return { pairs: enOnly.map(p2 => ({ zh: '', en: p2.trim() })), enOnly: true, comments: [], meta: parsed.meta, note: 'docx 纯英文段落' };
            }
          }
          // 纯英文文件（无中文段落）——按位置对齐到工作区
          if (nonEmpty.length > 0 && !nonEmpty.some(p2 => /[一-鿿]/.test(p2))) {
            return { pairs: nonEmpty.map(p2 => ({ zh: '', en: p2.trim() })), enOnly: true, comments: [], meta: parsed.meta, note: 'docx 纯英文' };
          }
          return { pairs: nonEmpty.map(p2 => ({ zh: p2, en: '' })), comments: [], meta: parsed.meta, note: 'docx 段落（仅原文）' };
        }
        if (/\.xlsx$/i.test(f.name)) {
          const sheets = await Office.xlsxToSheets(await f.arrayBuffer());
          const sheet = sheets.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
          const header = (sheet.rows[0] || []).map(h => String(h || '').trim());
          const m = IO.mapBilingualHeader(header);
          return { pairs: sheet.rows.slice(1).map(r => ({ zh: String(r[m.src] || ''), en: m.tgt >= 0 ? String(r[m.tgt] || '') : '' })), note: 'xlsx「' + sheet.name + '」' };
        }
        const text = await IO.readAsText(f);
        if (/<tmx[\s>]/i.test(text.slice(0, 400))) {
          const { tus } = IO.parseTMX(text);
          return { pairs: tus.map(tu => ({ zh: tu.src, en: tu.tgt })), note: 'TMX' };
        }
        if (/\.jsonl$/i.test(f.name)) {
          const objs = IO.parseJSONL(text);
          return { pairs: objs.filter(o => o.zh && o.en).map(o => ({ zh: o.zh, en: o.en })), note: 'JSONL' };
        }
        const { header, rows, mapping } = IO.sniffBilingualTable(text);
        return { pairs: rows.map(r => ({ zh: String(r[mapping.src] || ''), en: String(r[mapping.tgt] || '') })), note: 'CSV/TSV' };
      });
    }

    let revPending = null;
    let revParseGeneration = 0;
    $('#dlgRevision').addEventListener('close', () => {
      revParseGeneration++;
      revPending = null;
      $('#btnRevCommit').disabled = true;
    });
    $('#revFile').onchange = async () => {
      const generation = ++revParseGeneration;
      revPending = null;
      $('#btnRevCommit').disabled = true;
      const f = $('#revFile').files[0]; if (!f) return;
      const project = state.project;
      const segmentSnapshot = JSON.stringify(state.segments);
      $('#revPreview').innerHTML = '<div class="empty">解析并匹配中…</div>';
      try {
        const { pairs, note, comments, meta } = await revParsePairs(f);
        if (generation !== revParseGeneration) return;
        if (project !== state.project || segmentSnapshot !== JSON.stringify(state.segments)) throw new Error('工作区已变化，请重新选择修订文件。');
        const { plan, comments: mappedComments, matched, revised, unchanged, fresh } = window.MiniCatRevision.buildPlan(state.segments, pairs, comments);
        const author = ($('#revAuthor').value || '').trim();
        const label = ($('#revLabel').value || '').trim();
        const autoAuthors = [...new Set(pairs.filter(p2 => p2.author).map(p2 => p2.author))];
        const metaLine = meta && meta.lastModifiedBy ? `｜文件属性：最后修改人 ${esc(meta.lastModifiedBy)}` : '';
        revPending = { plan, author, label, sourceFile: f.name, comments: mappedComments, meta: meta || {}, project, segmentSnapshot };
        $('#revPreview').innerHTML = `<div class="mapping-note">来源：${esc(note)}｜共 ${plan.length + unchanged} 对。` +
          `匹配 <b>${matched}</b>，其中 <b style="color:var(--celadon-dark)">有修订 ${revised}</b>，无变化 ${unchanged}；未匹配将新增 <b>${fresh}</b> 段。` +
          (autoAuthors.length ? `｜<b>自动识别修订人</b>：${esc(autoAuthors.join('、'))}（来自 Word 修订记录）` : '') +
          (comments && comments.length ? `｜<b>检测到 Word 批注 ${comments.length} 条</b>（将导入批注模块）` : '') +
          `${metaLine}</div>` +
          plan.filter(p2 => p2.kind === 'rev').slice(0, 4).map(p2 => {
            const seg = state.segments[p2.idx];
            const ops = Diff.diffWords(seg.tgt || '', p2.en);
            return '<div class="diff-line">' + ops.map(o => o.t === 'eq' ? esc(o.text) : o.t === 'del' ? '<del>' + esc(o.text) + '</del>' : '<ins>' + esc(o.text) + '</ins>').join(' ') + '</div>';
          }).join('');
        $('#btnRevCommit').disabled = plan.length === 0 && mappedComments.length === 0;
      } catch (err) {
        if (generation !== revParseGeneration) return;
        revPending = null;
        $('#btnRevCommit').disabled = true;
        $('#revPreview').innerHTML = `<div class="mapping-note">解析失败：${esc(err.message || '')}</div>`;
      }
    };

    $('#btnRevCommit').onclick = async () => {
      if (!revPending) return;
      if (revPending.project !== state.project || revPending.segmentSnapshot !== JSON.stringify(state.segments)) {
        revPending = null;
        $('#btnRevCommit').disabled = true;
        $('#revPreview').textContent = '工作区已变化，请重新选择修订文件。';
        return;
      }
      const { plan, comments, meta } = revPending;
      revPending = null;
      $('#btnRevCommit').disabled = true;
      const manualAuthor = ($('#revAuthor').value || '').trim();
      const label = ($('#revLabel').value || '').trim();
      const today = new Date().toISOString().slice(0, 10);
      const metaDate = meta && meta.modified ? String(meta.modified).slice(0, 10) : '';
      // 作者/日期自动识别链：Word 修订记录 > 文件属性 > 手动输入 > 未署名
      const resolveAuthor = (pair) => (pair && pair.author) || manualAuthor || (meta && meta.lastModifiedBy) || '未署名';
      const resolveDate = (pair) => (pair && pair.date ? String(pair.date).slice(0, 10) : '') || metaDate || today;
      let revN = 0, newN = 0, cmtN = 0;
      let paraBase = state.segments.length ? (state.segments[state.segments.length - 1].para ?? -1) + 1 : 0;
      for (const p of plan) {
        if (p.kind === 'rev') {
          const seg = state.segments[p.idx];
          if (!Array.isArray(seg.revisions)) seg.revisions = [];
          const last = seg.revisions[seg.revisions.length - 1];
          const v = label || ('V' + (seg.revisions.length + 1));
          const runsChanged = p.runs ? JSON.stringify(Rich.normalize(p.runs, p.en)) !== JSON.stringify(Rich.normalize(seg.tgtRuns, seg.tgt || '')) : false;
          if (!last || !Diff.sameText(last.text, p.en) || runsChanged) {
            seg.revisions.push({ v, author: resolveAuthor(p.pair || p), text: p.en, runs: p.runs ? Rich.normalize(p.runs, p.en) : Rich.normalize(seg.tgtRuns, seg.tgt || ''), date: resolveDate(p.pair || p) });
          }
          seg.tgt = p.en;
          seg.tgtRuns = p.runs ? Rich.normalize(p.runs, p.en) : Rich.normalize(null, p.en);
          seg.status = 'translated';
          seg.applied = false;
          revN++;
        } else {
          const norm = Core.normalizeCJK(p.zh);
          const a = resolveAuthor(p.pair || p);
          const revs = [{ v: label || 'V1', author: manualAuthor || a, text: p.en, runs: p.runs ? Rich.normalize(p.runs, p.en) : undefined, date: resolveDate(p.pair || p) }];
          state.segments.push({
            src: p.zh, tgt: p.en, tgtRuns: p.runs ? Rich.normalize(p.runs, p.en) : undefined,
            status: 'translated', para: paraBase++,
            bestScore: 0, matches: [], revisions: revs, author: manualAuthor || a,
            key0: norm + '@R' + newN
          });
          newN++;
        }
      }
      // Word 批注 → 批注模块（使用预览阶段绑定的文件行目标；去重）
      const cmts = comments || [];
      for (const c2 of cmts) {
        const seg = state.segments[c2.idx];
        if (!Array.isArray(seg.comments)) seg.comments = [];
        if (seg.comments.some(x2 => x2.text === c2.text && x2.author === c2.author)) continue;
        seg.comments.push({ author: c2.author || '批注', text: c2.text, date: String(c2.date || '').slice(0, 10) || today });
        cmtN++;
      }
      $('#dlgRevision').close();
      await saveProjectNow();
      log(`修订导入完成：修订 ${revN} 段、新增 ${newN} 段、导入批注 ${cmtN} 条。`);
      await rematchAll();
      await saveProjectNow();
    };

    /* ---- 多模型译文对比 ---- */
    let mm = null;
    function resetMMDialog() {
      ['A','B','C','D'].forEach(k => {
        const f = document.getElementById('mmFile' + k); if (f) f.value = '';
        const n = document.getElementById('mmName' + k); if (n) n.value = '';
      });
      document.getElementById('mmStatus').textContent = '';
      document.getElementById('mmResults').hidden = true;
      mm = null;
    }
    $('#btnMultiModel').onclick = () => { resetMMDialog(); $('#dlgMultiModel').showModal(); };
    $('#btnMMCompare').onclick = async () => {
      const models = [];
      for (const k of ['A','B','C','D']) {
        const f = document.getElementById('mmFile' + k).files[0];
        if (!f) continue;
        const name = (document.getElementById('mmName' + k).value || '').trim() || ('模型 ' + k);
        models.push({ name, file: f });
      }
      if (models.length < 2) { $('#mmStatus').textContent = '请至少提供 2 个模型的译文文件。'; return; }
      $('#mmStatus').textContent = '解析中…';
      try {
        const parsedSets = [];
        for (const m of models) {
          const rp = await revParsePairs(m.file);
          const clean = rp.pairs.filter(p2 => p2.zh && p2.zh.trim() && p2.en && p2.en.trim())
            .map(p2 => ({ zh: p2.zh.trim(), en: p2.en.trim() }));
          parsedSets.push({ name: m.name, pairs: clean });
        }
        // 检查是否全部为纯英文模式（无中文匹配键，按位置对齐）
        const allEnOnly = parsedSets.every(ps => ps.enOnly);
        if (allEnOnly && state.segments.length > 0) {
          const rowsArr = state.segments.map((sg, i) => ({
            zh: sg.src, key: Core.normalizeCJK(sg.src), segIdx: i,
            para: sg.para, cands: []
          }));
          for (const set of parsedSets) {
            for (let i = 0; i < Math.min(set.pairs.length, rowsArr.length); i++) {
              const en = set.pairs[i].en;
              if (en && en.trim()) rowsArr[i].cands.push({ model: set.name, text: en });
            }
          }
          for (const row of rowsArr) row.cands = SR.rank(row.cands, row.zh, state.terms);
          mm = { models: parsedSets.map(ps => ps.name), rows: rowsArr, pos: 0 };
          $('#mmStatus').textContent = `对比完成（按位置对齐）：${rowsArr.length} 句 × ${models.length} 个模型。`;
          $('#mmResults').hidden = false;
          mmRenderCurrent();
          return;
        }
        // 以第一个模型为锚（canonical 分句），后续模型对齐到锚
        const anchor = parsedSets[0];
        const rest = parsedSets.slice(1);
        const rowsArr = [];
        // 锚的每个 pair → 一行
        anchor.pairs.forEach(p => {
          const key = Core.normalizeCJK(p.zh);
          const segIdx = state.segments.findIndex(sg => Core.normalizeCJK(sg.src) === key);
          rowsArr.push({
            zh: p.zh, key, segIdx,
            para: segIdx >= 0 ? state.segments[segIdx].para : null,
            cands: [{ model: anchor.name, text: p.en, score: 100, flags: [] }]
          });
        });
        // 后续模型：对齐到锚
        for (const set of rest) {
          const anchorNorms = rowsArr.map(r => Core.normalizeCJK(r.zh));
          const used = new Set();
          for (const p of set.pairs) {
            const norm = Core.normalizeCJK(p.zh);
            if (!norm) continue;
            // 1) 精确匹配
            let bestIdx = anchorNorms.indexOf(norm);
            if (bestIdx >= 0 && !used.has(bestIdx)) {
              used.add(bestIdx);
              rowsArr[bestIdx].cands.push({ model: set.name, text: p.en });
              continue;
            }
            // 2) Dice 模糊匹配（≥0.45）
            let best = -1, bestScore = 0;
            for (let ai = 0; ai < anchorNorms.length; ai++) {
              if (used.has(ai)) continue;
              const d = Core.diceCoefficient(norm, anchorNorms[ai]);
              if (d > bestScore) { bestScore = d; best = ai; }
            }
            if (best >= 0 && bestScore >= 0.45) {
              used.add(best);
              rowsArr[best].cands.push({ model: set.name, text: p.en });
            }
            // 3) 匹配不到 → 忽略（该模型没有翻到这段）
          }
        }
        mm = { models: parsedSets.map(ps => ps.name), rows: rowsArr, pos: 0 };
        $('#mmStatus').textContent = '对比完成：' + rowsArr.length + ' 句 × ' + models.length + ' 个模型。';
        $('#mmResults').hidden = false;
        mmRenderCurrent();
      } catch (err) { $('#mmStatus').textContent = '解析失败：' + (err.message || err); }
    };
    function mmRenderCurrent() {
      if (!mm || !mm.rows.length) return;
      const row = mm.rows[mm.pos];
      const seg = row.segIdx >= 0 ? state.segments[row.segIdx] : null;
      $('#mmPos').textContent = '第 ' + (mm.pos + 1) + ' / ' + mm.rows.length + ' 句';
      const rec = row.cands[0];
      let h = '<div class="mm-zh"><b>原文</b>：' + esc(row.zh) + '</div>';
      if (seg && seg.tgt) h += '<div class="mm-zh" style="color:var(--muted);font-size:13px"><b>当前</b>：' + esc(seg.tgt.slice(0, 160)) + '</div>';
      for (const c of row.cands) {
        const isRec = c === rec && row.cands.length > 1;
        const fl = (c.flags || []).map(f2 => '<div class="term-note ' + (f2.level === '违规' ? 'mm-violation' : '') + '">' + esc(f2.level) + '：' + esc(f2.message) + '</div>').join('');
        h += '<div class="mm-cand ' + (isRec ? 'recommended' : '') + '"><div class="mm-cand-head"><b>' + esc(c.model) + '</b><span class="src-badge">' + c.score + ' 分</span>' + (isRec ? '<span class="src-badge rec">推荐</span>' : '') + '<span style="flex:1"></span><button class="linkbtn mm-adopt" data-model="' + esc(c.model) + '">' + (seg && seg.tgt ? '覆盖' : '采用') + '</button></div><div class="mm-text">' + esc(c.text) + '</div>' + fl + '</div>';
      }
      const missing = mm.models.filter(m2 => !row.cands.some(c2 => c2.model === m2));
      if (missing.length) h += '<div class="term-note">未提供该句译文：' + esc(missing.join('、')) + '</div>';
      $('#mmSentence').innerHTML = h;
    }
    async function mmAdopt(model) {
      if (!mm) return;
      const row = mm.rows[mm.pos];
      const cand = row.cands.find(c2 => c2.model === model);
      if (!cand) return;
      let idx = row.segIdx;
      if (idx < 0) {
        const norm = Core.normalizeCJK(row.zh);
        const paraBase = state.segments.length ? (state.segments[state.segments.length - 1].para ?? -1) + 1 : 0;
        state.segments.push({ src: row.zh, tgt: '', status: 'untranslated', para: paraBase, bestScore: 0, matches: [], key0: norm + '@MM' + idx });
        idx = state.segments.length - 1;
        row.segIdx = idx;
      }
      const seg = state.segments[idx];
      if (seg.tgt && seg.tgt.trim() && !confirm('覆盖已有译文？')) return;
      seg.tgt = cand.text; seg.tgtRuns = undefined; seg.mt = true;
      if (!Array.isArray(seg.comments)) seg.comments = [];
      seg.comments.push({ author: state.author || '译者', text: '采用' + model + '译文（体例评分 ' + cand.score + '）——确认入库前由译者本人改写定稿', date: today() });
      await saveProjectNow(); mmRenderCurrent(); renderSegments(); renderStats();
      log('已采用 ' + model + ' 译文为工作译文（待改写）。');
    }
    function mmExport() {
      if (!mm || !mm.rows.length) return;
      const head = ['序号', '中文原文', '工作区状态'].concat(mm.models).concat(['推荐', '推荐分']);
      const rows2 = [head];
      mm.rows.forEach((row, i) => {
        const rec = row.cands[0];
        const line = [i + 1, row.zh, row.segIdx >= 0 ? (state.segments[row.segIdx].status === 'translated' ? '已译' : '未译') : '—'];
        for (const m2 of mm.models) { const c2 = row.cands.find(x => x.model === m2); line.push(c2 ? c2.text + '（' + c2.score + '）' : ''); }
        line.push(rec ? rec.model : ''); line.push(rec ? rec.score : '');
        rows2.push(line);
      });
      IO.download('多模型对照_' + state.project + '_' + today() + '.xlsx', Write.buildXlsx([{ name: '多模型对照', rows: rows2 }]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    $('#mmPrev').onclick = () => { if (mm && mm.pos > 0) { mm.pos--; mmRenderCurrent(); } };
    $('#mmNext').onclick = () => { if (mm && mm.pos < mm.rows.length - 1) { mm.pos++; mmRenderCurrent(); } };
    $('#btnMMExport').onclick = mmExport;
    $('#mmSentence').addEventListener('click', e => { const btn = e.target.closest('.mm-adopt'); if (btn) mmAdopt(btn.dataset.model); });

    /* ---- MT suggestionsMMEOF
echo "mm_code written"
PYEOF
wc -c /tmp/mm_code.js
__zcode_status=$?
if [ "$__zcode_status" -eq 0 ]; then pwd -P > '/var/folders/cx/84th5zjj7gn2k54hnd720ghw0000gn/T/zcode-ad5441bf-ab5d-415e-91e4-145aff208a2a-cwd'; fi
exit "$__zcode_status"
    /* ---- MT suggestions: Chrome built-in on-device Translator API (no network egress of user data;
     * feature-detected, the button stays hidden where unsupported) ---- */
    let _translator = null;
    async function ensureTranslator() {
      if (_translator !== null) return _translator;
      try {
        if (!('Translator' in self) || !self.Translator || !self.Translator.create) { _translator = false; return false; }
        const avail = await self.Translator.availability({ sourceLanguage: 'zh', targetLanguage: 'en' });
        if (avail === 'unavailable') { _translator = false; return false; }
        _translator = await self.Translator.create({ sourceLanguage: 'zh', targetLanguage: 'en' });
        return _translator;
      } catch (err) { _translator = false; return false; }
    }
    async function applyMt() {
      const tr = await ensureTranslator();
      if (!tr) { alert('当前浏览器不支持端侧翻译 API（需要 Chrome 138+ 且语言包可用）。'); return; }
      const targets = state.segments.filter(s => s.status !== 'translated' && !(s.tgt || '').trim());
      if (!targets.length) { log('没有需要 MT 建议的空段。'); return; }
      setBusy(true, `端侧生成 MT 建议… 0/${targets.length}`);
      let done = 0;
      for (const seg of targets) {
        try { seg.tgt = await tr.translate(seg.src); seg.mt = true; } catch (err) { /* skip */ }
        done++;
        if (done % 5 === 0 || done === targets.length) {
          setBusy(true, `端侧生成 MT 建议… ${done}/${targets.length}`);
          renderSegments(); renderStats();
          await new Promise(r => setTimeout(r, 0));
        }
      }
      setBusy(false);
      log(`MT 建议：已填入 ${done} 段（可逐段修改后确认入库）。`);
      saveProjectDebounced();
    }

    /* ---- backup reminder ---- */
    async function checkBackupReminder() {
      const n = state.tm.length + state.terms.length;
      if (n < 10) return;
      const last = await DB.Meta.get('lastBackupAt', 0);
      if (Date.now() - last < 7 * 864e5) return;
      const banner = $('#backupBanner');
      if (banner) banner.style.display = '';
    }
    function hideBackupBanner() { const b = $('#backupBanner'); if (b) b.style.display = 'none'; }

    /* ---- drag & drop restore ---- */
    function setupDragDrop() {
      document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dropping'); });
      document.addEventListener('dragleave', e => { if (e.relatedTarget === null) document.body.classList.remove('dropping'); });
      document.addEventListener('drop', async e => {
        e.preventDefault();
        document.body.classList.remove('dropping');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        if (/\.json$/i.test(f.name)) {
          try { await restoreFromJsonText(await IO.readAsText(f)); } catch (err) { alert('恢复失败：' + err.message); }
        } else {
          log('拖拽仅支持恢复备份 .json 文件；请用「导入」按钮导入记忆库/术语库/原文。');
        }
      });
    }

    function today() { return new Date().toISOString().slice(0, 10); }

    function bilingualHtml(rows) {
      const escH = Core.escapeHtml;
      let h = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>双语对照 ${escH(state.project)}</title>
      <style>body{font-family:'Songti SC',SimSun,Georgia,serif;margin:40px auto;max-width:1000px;color:#222}
      table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #bbb;padding:6px 8px;vertical-align:top;text-align:left;white-space:pre-wrap}
      th{background:#f2ede4}tr:nth-child(even) td{background:#faf8f4}.zh{width:38%}.en{width:42%}</style></head><body>
      <h2>双语对照 — ${escH(state.project)}</h2><p>Mini-CAT 导出 · ${today()}</p>
      <table><tr><th>#</th><th>状态</th><th>匹配</th><th class="zh">中文</th><th class="en">英文</th></tr>`;
      for (const r of rows.slice(1)) {
        h += `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${escH(r[3])}</td><td>${typeof r[4]==='object'?Rich.toHTML(r[4].runs,r[4].text):escH(r[4])}</td></tr>`;
      }
      h += '</table></body></html>';
      return h;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
