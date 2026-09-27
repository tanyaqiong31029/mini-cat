/* Lossless, explicit bilingual boundary editing. Never modifies the TM. */
(function(root,factory){
  if(typeof module!=='undefined'&&module.exports)module.exports=factory(require('./richtext.js'));
  else root.MiniCatSegmentOps=factory(root.MiniCatRichText);
})(typeof globalThis!=='undefined'?globalThis:this,function(Rich){
  'use strict';
  function cut(text,offset){
    if(!Number.isInteger(offset)||offset<0||offset>text.length)throw new Error('请选择有效的拆分位置。');
    if(offset>0&&offset<text.length&&/[\uD800-\uDBFF]/.test(text[offset-1])&&/[\uDC00-\uDFFF]/.test(text[offset]))throw new Error('不能在同一个字符内部拆分。');
  }
  function sliceRuns(runs,text,start,end){
    let pos=0;
    return Rich.normalize(Rich.normalize(runs,text).flatMap(r=>{
      const from=Math.max(0,start-pos),to=Math.min(r.text.length,end-pos);pos+=r.text.length;
      return from<to?[{...r,text:r.text.slice(from,to)}]:[];
    }));
  }
  function snapshot(seg){
    return {src:seg.src,tgt:seg.tgt||'',tgtRuns:Rich.normalize(seg.tgtRuns,seg.tgt||''),para:seg.para??null,key0:seg.key0||'',author:seg.author||'',revisions:structuredClone(seg.revisions||[]),comments:structuredClone(seg.comments||[])};
  }
  function archive(segs){
    const list=segs.flatMap(s=>[...(s.alignmentHistory||[]),snapshot(s)]),seen=new Set();
    const result=list.filter(s=>{const k=JSON.stringify(s);if(seen.has(k))return false;seen.add(k);return true;});
    if(result.length>100)throw new Error('句对调整历史超过 100 份，请先备份并拆分项目。');
    return structuredClone(result);
  }
  function base(seg,history){
    return {src:seg.src,tgt:seg.tgt||'',tgtRuns:Rich.normalize(seg.tgtRuns,seg.tgt||''),para:seg.para??null,key0:seg.key0||'',author:seg.author||'',joinNext:seg.joinNext===true,status:'untranslated',applied:false,mt:false,matches:[],bestScore:0,revisions:[],comments:[],alignmentHistory:history};
  }
  function split(seg,sourceOffset,targetOffset,id){
    const src=String(seg.src||''),tgt=String(seg.tgt||'');cut(src,sourceOffset);cut(tgt,targetOffset);
    if(!src.slice(0,sourceOffset).trim()||!src.slice(sourceOffset).trim())throw new Error('原文两侧都必须有文字；请在句中选择拆分位置。');
    const history=archive([seg]),a=base(seg,history),b=base(seg,structuredClone(history));
    a.src=src.slice(0,sourceOffset);b.src=src.slice(sourceOffset);
    a.tgt=tgt.slice(0,targetOffset);b.tgt=tgt.slice(targetOffset);
    a.tgtRuns=sliceRuns(seg.tgtRuns,tgt,0,targetOffset);b.tgtRuns=sliceRuns(seg.tgtRuns,tgt,targetOffset,tgt.length);
    a.splitLink={id:String(id),side:'left'};b.splitLink={id:String(id),side:'right'};
    // The left boundary is lossless even after either half is split again.
    a.joinNext=true;
    b.key0=(seg.key0||'segment')+'@split:'+id;
    return [a,b];
  }
  function joiner(a,b,source,crossParagraph){
    if(!a||!b||/\s$/.test(a)||/^\s/.test(b))return '';
    if(crossParagraph)return '\n';
    return source&&(/[\u3400-\u9fff。！？；，、”）]$/.test(a)||/^[\u3400-\u9fff]/.test(b))?'':' ';
  }
  function merge(a,b,mode='auto'){
    if(!a||!b)throw new Error('只能合并实际相邻的两条句对。');
    const sibling=a.splitLink&&b.splitLink&&a.splitLink.id===b.splitLink.id&&a.splitLink.side==='left'&&b.splitLink.side==='right';
    const cross=a.para==null||b.para==null||a.para!==b.para;
    const srcJoin=mode==='direct'||sibling||a.joinNext===true?'':joiner(a.src,b.src,true,cross);
    const tgtJoin=mode==='direct'||sibling||a.joinNext===true?'':joiner(a.tgt||'',b.tgt||'',false,cross);
    const result=base(a,archive([a,b]));
    result.src=a.src+srcJoin+b.src;result.tgt=(a.tgt||'')+tgtJoin+(b.tgt||'');
    result.tgtRuns=Rich.normalize([...Rich.normalize(a.tgtRuns,a.tgt||''),{text:tgtJoin},...Rich.normalize(b.tgtRuns,b.tgt||'')]);
    result.para=cross?null:a.para;
    result.joinNext=b.joinNext===true;
    return result;
  }
  function targetSeparator(a,b){
    return a.joinNext===true?'':joiner(a.tgt||'',b.tgt||'',false,false);
  }
  return {split,merge,sliceRuns,targetSeparator};
});
