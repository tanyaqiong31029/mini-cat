/* Mini-CAT application: UI wiring, workspace state, matching pipeline. */
(function () {
  'use strict';
  const Core = window.MiniCatCore, DB = window.MiniCatDB, IO = window.MiniCatIO, Office = window.MiniCatOffice, Write = window.MiniCatWrite, Web = window.MiniCatWebRef;
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
    const exist = new Set(state.segments.map(s2 => s2.key0 || Core.normalizeCJK(s2.src)));
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
          <button class="linkbtn webref-go" data-id="${t.id}" title="联网查阅该术语">🌐</button></div>
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
        if (g.error) h += `<div class="term-note">网络受限或超时——请用下方直达链接。</div>`;
        for (const hit of g.hits.slice(0, 5)) {
          const meta = [hit.date, hit.culture, hit.medium, hit.year && (hit.year + '年'), hit.creator, hit.highlight ? '⭐ 馆方高亮藏品' : '']
            .filter(Boolean).map(x => esc(String(x))).join(' · ');
          const enish = typeof hit.title === 'string' ? hit.title : '';
          h += `<div class="hit-row">
            <a class="hit-title" href="${esc(hit.url)}" target="_blank" rel="noopener noreferrer">${esc(hit.title)}</a>
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
      const kw = ($('#webrefInput').value || '').trim();
      const status = $('#webrefStatus');
      if (!kw) { $('#webrefList').innerHTML = '<div class="empty">输入关键词后自动抓取多源参考。</div>'; return; }
      const term = state.webrefTerm;
      const isCJK = /[一-鿿]/.test(kw);
      const zhTerm = isCJK ? kw : (term ? term.zh : '');
      let enTerm = !isCJK ? kw : (($('#webrefEn').checked && term && term.en) ? term.en : '');
      status.textContent = '正在抓取：维基百科 / 大都会博物馆 / 书目…';
      try {
        const data = await Web.lookupAll(zhTerm, enTerm, { met: !!enTerm, archive: !!enTerm });
        status.textContent = '';
        webrefRender(data, kw);
      } catch (err) {
        status.textContent = '';
        $('#webrefList').innerHTML = `<div class="empty">抓取失败：${esc(err.message || '')}。请使用直达链接。</div>`;
      }
    }
    $('#webrefInput').addEventListener('keydown', e => { if (e.key === 'Enter') runWebRef(); });
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
      let cur = null;
      for (const s of segs) {
        const t = zhSide ? (s.src || '') : (s.tgt || '');
        if (cur === null || s.para == null || s.para !== cur.para) {
          cur = { para: s.para, parts: [] };
          out.push(cur);
        }
        cur.parts.push(t.trim());
      }
      return out.map(p => ({ para: p.para, text: p.parts.filter(Boolean).join(zhSide ? '' : ' ') }));
    }
    function docxBlocksTitle(sub) {
      return [{ type: 'h1', text: state.project }, { type: 'p', text: sub, italic: true, gray: true }];
    }
    $('#btnDocPure').onclick = () => {
      const paras = paragraphsFromSegs(exportSegs(), false);
      const blocks = docxBlocksTitle(`纯译文 · ${today()}`)
        .concat(paras.map(p => ({ type: 'p', text: p.text || '（待译）' })));
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
        blocks.push({ type: 'p', text: s.tgt || '（待译）', italic: true, gray: true });
      }
      IO.download(`中英对照_${state.project}_${today()}.docx`, Write.buildDocx(blocks), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    };
    $('#btnSentDocx').onclick = () => {
      const segs = exportSegs();
      const rows = segs.map((s, i) => [i + 1, s.src, s.tgt || '']);
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
    $('#btnExpBilingual').onclick = () => {
      const rows = [['#', '状态', '匹配', '中文', '英文']]
        .concat(exportSegs().map((s, i) => [i + 1, s.status === 'translated' ? '已译' : '未译', s.bestScore || 0, s.src, s.tgt || '']));
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
      await DB.TM.addMany(newTm);
      await DB.Terms.addMany(newTerms);
      for (const p of clean.projects) await DB.Projects.put(p);
      state.projects = (await DB.Projects.all()).map(p => p.name);
      await refreshAll();
      await rematchAll();
      log(`备份恢复完成：新增记忆 ${newTm.length}、新增术语 ${newTerms.length}（跳过重复 ${skipped}）。`);
    }
    async function restoreBackup(e) {
      const f = e.target.files[0]; if (!f) return;
      try { await restoreFromJsonText(await IO.readAsText(f)); }
      catch (err) { alert('恢复失败：' + err.message); }
    }

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
