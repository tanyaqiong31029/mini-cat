(function(root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./term-engine.js'));
  else root.MiniCatCandidates = factory(root.MiniCatTermEngine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Engine) {
  'use strict';
  function scan(segments, existing, minFreq) {
    const pairs = segments.filter(s => s && typeof s.src === 'string' && s.src.trim() && typeof s.tgt === 'string' && s.tgt.trim()).map(s => ({src:s.src,tgt:s.tgt}));
    if (pairs.length < 3) throw new Error('至少需要 3 个已有译文的句段；未译段落不会参与双语提取。');
    if (pairs.some(p => p.src.length > 20000 || p.tgt.length > 20000) || pairs.reduce((n,p)=>n+p.src.length+p.tgt.length,0) > 2000000) throw new Error('文本过大，请拆分项目后提取（最多 200 万字符，单句最多 2 万字符）。');
    if (!/[\u3400-\u9fff]/.test(pairs.map(p=>p.src).join('')) || !/[a-zA-Z]/.test(pairs.map(p=>p.tgt).join(''))) throw new Error('当前模块用于中文原文→英文译文。未识别到该语言对，请检查原译文列。');
    const {candidates,stats} = Engine.extractCandidates(pairs,{minFreq:minFreq===1?1:2,zhMinFreq:minFreq===1?1:2,topN:300});
    Engine.voteTranslations(candidates,pairs);
    const known = new Set((existing||[]).map(t=>Engine.normKey(t.zh)));
    const filtered = candidates.filter(c=>!known.has(Engine.normKey(c.term)));
    return {candidates:filtered, stats:{...stats,eligible:pairs.length,skipped:segments.length-pairs.length,existing: candidates.length-filtered.length},warning:pairs.length<5?'句对较少，统计译文不可靠，请逐条结合例句确认。':''};
  }
  function acceptedRows(candidates, decisions) {
    const result = Engine.validateDecisions(decisions,candidates);
    if (!result.valid) throw new Error(result.errors.join('；'));
    return decisions.filter(d=>d.accept).map(d=>{
      if (!d.tgt || !d.tgt.trim()) throw new Error('请为已勾选术语填写或确认英文译名：'+d.term);
      if(d.term.length>500 || d.tgt.length>2000)throw new Error('术语或译名过长');
      const c=candidates.find(c=>c.term===d.term);
      return {zh:d.term,en:d.tgt.trim(),status:'confirmed',note:'人工确认候选术语｜出现 '+c.freq+' 次'+(d.note?'｜'+d.note:'')};
    });
  }
  return {scan,acceptedRows};
});
