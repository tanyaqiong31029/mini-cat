/* Mini-CAT webref.js — 联网术语查阅：多源开放 API + 权威站点直达链接。
 * 零依赖；只做"查阅/参考"，绝不自动写入译文（采纳须人工点击，见 app.js）。
 * 所有请求带超时与降级：抓取失败仅影响对应卡片，直达链接永远可用。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.MiniCatWebRef = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function stripHtml(s) {
    return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  /* fetch with timeout; returns parsed JSON or throws */
  async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 9000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, headers: { 'Api-User-Agent': 'MiniCAT/1.3 (translator reference tool)' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } finally { clearTimeout(timer); }
  }

  /* ---------- MediaWiki（zh/en 维基百科；origin=* 允许跨域） ---------- */
  async function wikipedia(lang, term, limit) {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=search&srsearch=${encodeURIComponent(term)}&srlimit=${limit || 3}`;
    const data = await fetchJson(url);
    const hits = ((data.query || {}).search || []).map(h => ({
      title: h.title,
      snippet: stripHtml(h.snippet),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`
    }));
    return { source: lang === 'zh' ? '中文维基百科' : 'English Wikipedia', hits };
  }

  /* ---------- 大都会艺术博物馆（开放 API，CORS 开放；英文用法权威证据） ---------- */
  async function metMuseum(term, limit) {
    const s = await fetchJson(`https://collectionapi.metmuseum.org/public/collection/v1/search?q=${encodeURIComponent(term)}&hasImages=true`, 9000);
    const ids = (s.objectIDs || []).slice(0, (limit || 4) * 2);
    const out = [];
    for (const id of ids) {
      if (out.length >= (limit || 4)) break;
      try {
        const o = await fetchJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, 9000);
        if (!o.title) continue;
        out.push({
          title: o.title,
          highlight: !!o.isHighlight,
          date: o.objectDate || '',
          culture: o.culture || '',
          medium: o.medium || '',
          url: o.objectURL || `https://www.metmuseum.org/art/collection/search/${id}`
        });
      } catch (e) { /* skip object */ }
    }
    out.sort((a, b) => (b.highlight ? 1 : 0) - (a.highlight ? 1 : 0)); // 高亮藏品优先 = 机构背书强度
    return { source: '大都会艺术博物馆', hits: out };
  }

  /* ---------- Internet Archive 公开书目（哪些出版过该书目的书里出现该词） ---------- */
  async function archiveBooks(term, limit) {
    const q = encodeURIComponent(`"${term}"`);
    const url = `https://archive.org/advancedsearch.php?q=${q}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&fl%5B%5D=creator&rows=${limit || 5}&page=1&output=json`;
    const data = await fetchJson(url, 12000);
    const docs = ((data.response || {}).docs || []);
    return {
      source: 'Internet Archive 书目',
      hits: docs.map(d => ({
        title: d.title || d.identifier,
        year: d.year || '',
        creator: Array.isArray(d.creator) ? d.creator.join('; ') : (d.creator || ''),
        url: `https://archive.org/details/${d.identifier}`
      }))
    };
  }

  /* ---------- 权威站点直达链接（抓取失败时的保底，且覆盖无 CORS 的权威库） ---------- */
  function buildLinks(zhTerm, enTerm) {
    const zh = encodeURIComponent(zhTerm || '');
    const en = encodeURIComponent(enTerm || zhTerm || '');
    const both = encodeURIComponent([zhTerm, enTerm].filter(Boolean).join(' '));
    const bing = (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
    return [
      { name: '术语在线（全国科技名词委）', url: `https://www.termonline.cn/search?searchText=${zh}`, note: '规范术语最高权威' },
      { name: '故宫数字文物库', url: bing(`site:digicol.dpm.org.cn ${zhTerm || ''}`), note: '故宫院藏器物定名' },
      { name: '台北故宫典藏', url: bing(`site:theme.npm.edu.tw ${enTerm || zhTerm || ''}`), note: '中文器物英译对照' },
      { name: 'Met Museum 站内', url: `https://www.metmuseum.org/search-results?q=${en}`, note: '英文藏名用法' },
      { name: 'Google Scholar', url: `https://scholar.google.com/scholar?q=${both}`, note: '学术文献用法' },
      { name: 'Bing', url: bing(both || zhTerm || ''), note: '全网检索' },
      { name: '百度百科', url: `https://baike.baidu.com/item/${zh}`, note: '中文释义参考' }
    ];
  }

  /* 汇总：并行抓取，单项失败不影响整体 */
  async function lookupAll(zhTerm, enTerm, opts) {
    opts = opts || {};
    const tasks = [];
    if (zhTerm) tasks.push(wikipedia('zh', zhTerm, 3).catch(e => ({ source: '中文维基百科', error: String(e.message || e), hits: [] })));
    if (enTerm) tasks.push(wikipedia('en', enTerm, 3).catch(e => ({ source: 'English Wikipedia', error: String(e.message || e), hits: [] })));
    if (enTerm && opts.met !== false) tasks.push(metMuseum(enTerm, 4).catch(e => ({ source: '大都会艺术博物馆', error: String(e.message || e), hits: [] })));
    if (enTerm && opts.archive !== false) tasks.push(archiveBooks(enTerm, 5).catch(e => ({ source: 'Internet Archive 书目', error: String(e.message || e), hits: [] })));
    const results = await Promise.all(tasks);
    return { results, links: buildLinks(zhTerm, enTerm) };
  }

  return { stripHtml, fetchJson, wikipedia, metMuseum, archiveBooks, buildLinks, lookupAll };
});
