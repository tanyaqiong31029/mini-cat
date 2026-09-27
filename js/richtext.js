/* Safe, text-first translation formatting. No stored HTML is trusted. */
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  if(root) root.MiniCatRichText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  const marks = ['bold','italic','underline','superscript','subscript'];
  const blocks = new Set(['DIV','P','LI','UL','OL','H1','H2','H3','H4','H5','H6','PRE','BLOCKQUOTE']);
  const forbidden = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','TEMPLATE','NOSCRIPT']);
  function same(a,b){return marks.every(k=>!!a[k]===!!b[k]);}
  function normalize(runs, fallbackText){
    const out=[];
    for(const value of Array.isArray(runs)?runs:[]){
      if(!value || typeof value.text!=='string' || !value.text) continue;
      const run={text:value.text};
      for(const k of marks) if(value[k]===true) run[k]=true;
      if(run.superscript) delete run.subscript;
      const last=out[out.length-1];
      if(last && same(last,run)) last.text+=run.text; else out.push(run);
    }
    if(typeof fallbackText==='string' && text(out)!==fallbackText) return fallbackText?[{text:fallbackText}]:[];
    return out;
  }
  function text(runs){return (Array.isArray(runs)?runs:[]).map(r=>r && typeof r.text==='string'?r.text:'').join('');}
  function escape(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function toHTML(runs, fallbackText){
    return normalize(runs,fallbackText).map(r=>{
      let html=escape(r.text);
      for(const [mark,tag] of [['bold','strong'],['italic','em'],['underline','u'],['superscript','sup'],['subscript','sub']]) if(r[mark]) html='<'+tag+'>'+html+'</'+tag+'>';
      return html;
    }).join('');
  }
  // The same traversal powers extraction and selection mapping, including native
  // contenteditable DIV/P line breaks. CSS/attributes are deliberately ignored.
  function scan(editor){
    const runs=[], positions=new Map(), boundaries=new Map(); let length=0, tail='';
    function emit(value,style){if(!value)return; runs.push(Object.assign({text:value},style)); length+=value.length;tail=value.slice(-1);}
    function walk(node,style){
      if(node.nodeType===3){positions.set(node,length);emit(node.nodeValue||'',style);return;}
      if(node.nodeType!==1 && node.nodeType!==11)return;
      const tag=(node.tagName||'').toUpperCase();
      if(forbidden.has(tag)){boundaries.set(node,[length]);return;}
      const next=Object.assign({},style);
      if(tag==='B'||tag==='STRONG')next.bold=true;
      if(tag==='I'||tag==='EM')next.italic=true;
      if(tag==='U')next.underline=true;
      if(tag==='SUP'){next.superscript=true;delete next.subscript;}
      if(tag==='SUB'){next.subscript=true;delete next.superscript;}
      if(node!==editor && blocks.has(tag) && length && tail!=='\n')emit('\n',{});
      const blockStart=length;
      const offsets=[length];boundaries.set(node,offsets);
      if(tag==='BR'){
        // Native contenteditable uses a sole BR as an empty-line placeholder.
        const parent=node.parentNode;
        if(parent && parent.childNodes.length===1 && (parent===editor || blocks.has((parent.tagName||'').toUpperCase())))return;
        emit('\n',next);return;
      }
      const children=Array.from(node.childNodes||[]);
      children.forEach(child=>{walk(child,next);offsets.push(length);});
      if(node!==editor && blocks.has(tag) && node.nextSibling && (tail!=='\n'||length===blockStart))emit('\n',{});
    }
    walk(editor,{});
    return {runs:normalize(runs),positions,boundaries,length};
  }
  function fromDOM(editor){const runs=scan(editor).runs;return {runs,text:text(runs)};}
  function format(runs,start,end,kind){
    runs=normalize(runs);const size=text(runs).length;
    start=Math.max(0,Math.min(size,Number(start)||0));end=Math.max(start,Math.min(size,Number(end)||0));
    if(start===end || (!marks.includes(kind)&&kind!=='clear'&&kind!=='remove'))return runs;
    let offset=0;const selected=runs.filter(r=>{const begin=offset;offset+=r.text.length;return begin<end&&offset>start;});
    const unset=selected.every(r=>r[kind]);const result=[];offset=0;
    for(const r of runs){
      const a=Math.max(0,start-offset),b=Math.min(r.text.length,end-offset);
      if(a<b){
        if(a)result.push(Object.assign({},r,{text:r.text.slice(0,a)}));
        const middle=Object.assign({},r,{text:r.text.slice(a,b)});
        if(kind==='clear'||kind==='remove')marks.forEach(k=>delete middle[k]);
        else if(unset)delete middle[kind];
        else {middle[kind]=true;if(kind==='superscript')delete middle.subscript;if(kind==='subscript')delete middle.superscript;}
        result.push(middle);
        if(b<r.text.length)result.push(Object.assign({},r,{text:r.text.slice(b)}));
      }else result.push(r);
      offset+=r.text.length;
    }
    return normalize(result);
  }
  function selectionOffsets(editor){
    const selection=editor.ownerDocument.defaultView.getSelection();
    if(!selection||!selection.rangeCount)return null;
    const range=selection.getRangeAt(0);
    if(!editor.contains(range.startContainer)||!editor.contains(range.endContainer))return null;
    const data=scan(editor);
    function offset(node,index){
      if(data.positions.has(node))return data.positions.get(node)+Math.min(index,(node.nodeValue||'').length);
      const list=data.boundaries.get(node);return list?list[Math.min(index,list.length-1)]:null;
    }
    const start=offset(range.startContainer,range.startOffset),end=offset(range.endContainer,range.endOffset);
    return start===null||end===null?null:{start,end};
  }
  function restoreSelection(editor,start,end){
    const data=scan(editor),doc=editor.ownerDocument;
    function point(value){
      value=Math.max(0,Math.min(data.length,Number(value)||0));
      for(const [node,begin] of data.positions){if(value>=begin&&value<=begin+node.nodeValue.length)return [node,value-begin];}
      // Breaks have no text node, so use an element child boundary.
      for(const [node,list] of data.boundaries){const index=list.indexOf(value);if(index>=0)return [node,index];}
      return [editor,editor.childNodes.length];
    }
    const a=point(start),b=point(end),range=doc.createRange();range.setStart(a[0],a[1]);range.setEnd(b[0],b[1]);
    editor.focus();const selection=doc.defaultView.getSelection();selection.removeAllRanges();selection.addRange(range);
  }
  function applyFormat(editor,kind){
    const selection=selectionOffsets(editor);if(!selection||selection.start===selection.end)return null;
    const runs=format(fromDOM(editor).runs,selection.start,selection.end,kind);
    editor.innerHTML=toHTML(runs);restoreSelection(editor,selection.start,selection.end);return runs;
  }
  return {normalize,text,toHTML,fromDOM,format,selectionOffsets,restoreSelection,applyFormat};
});
