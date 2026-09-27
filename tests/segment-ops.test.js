const assert=require('node:assert/strict');
const Ops=require('../js/segment-ops.js'),IO=require('../js/io.js');
let count=0;function test(name,fn){fn();count++;console.log('✓ '+name);}
const original={src:'甲句。乙句。',tgt:'First. Second.',tgtRuns:[{text:'First.',bold:true},{text:' Second.',italic:true}],para:0,key0:'original@0',status:'translated',revisions:[{text:'Old text',v:'V1',author:'A'}],comments:[{text:'Keep comment',author:'B'}]};
test('split preserves every source/target character and formats',()=>{
 const [a,b]=Ops.split(original,3,7,'test');assert.equal(a.src+b.src,original.src);assert.equal(a.tgt+b.tgt,original.tgt);assert.equal(a.tgtRuns[0].bold,true);assert.equal(b.tgtRuns[0].italic,true);assert.equal(a.status,'untranslated');assert.equal(b.para,0);assert.notEqual(a.key0,b.key0);
});
test('history is archived, not assigned to mismatched new text',()=>{
 const [a,b]=Ops.split(original,3,7,'test');assert.deepEqual(a.revisions,[]);assert.equal(a.alignmentHistory[0].revisions[0].text,'Old text');assert.equal(b.alignmentHistory[0].comments[0].text,'Keep comment');a.alignmentHistory[0].comments[0].text='changed';assert.equal(original.comments[0].text,'Keep comment');assert.equal(b.alignmentHistory[0].comments[0].text,'Keep comment');
});
test('split and remerge siblings is exactly text reversible',()=>{
 const pieces=Ops.split({...original,tgt:'FirstSecond',tgtRuns:[]},3,5,'same');const merged=Ops.merge(...pieces);assert.equal(merged.tgt,'FirstSecond');assert.equal(merged.src,original.src);
});
test('empty translation can split without invented text',()=>{
 const [a,b]=Ops.split({src:'你好世界',tgt:null},2,0,'empty');assert.equal(a.tgt,'');assert.equal(b.tgt,'');assert.deepEqual(a.tgtRuns,[]);
});
test('translation boundaries can leave one side untranslated',()=>{assert.equal(Ops.split(original,3,0,'x')[0].tgt,'');assert.equal(Ops.split(original,3,original.tgt.length,'x')[1].tgt,'');});
test('reject source endpoints, invalid positions and half surrogate',()=>{
 for(const i of [0,original.src.length,-1,1.5])assert.throws(()=>Ops.split(original,i,1,'x'));
 assert.throws(()=>Ops.split({src:'甲😀乙',tgt:''},2,0,'x'),/字符/);
 assert.throws(()=>Ops.split(original,3,100,'x'));
});
test('merge respects Chinese and English spacing',()=>{
 const r=Ops.merge({src:'甲。',tgt:'First.',para:1},{src:'乙。',tgt:'Second.',para:1});assert.equal(r.src,'甲。乙。');assert.equal(r.tgt,'First. Second.');assert.equal(r.para,1);
});
test('merge keeps existing whitespace and cross paragraph newlines',()=>{
 assert.equal(Ops.merge({src:'甲',tgt:'First ',para:1},{src:'乙',tgt:'Second',para:1}).tgt,'First Second');
 const r=Ops.merge({src:'甲',tgt:'First',para:1},{src:'乙',tgt:'Second',para:2});assert.equal(r.src,'甲\n乙');assert.equal(r.tgt,'First\nSecond');assert.equal(r.para,null);
});
test('explicit direct connection does not add punctuation/spaces',()=>assert.equal(Ops.merge({src:'甲',tgt:'First'},{src:'乙',tgt:'Second'},'direct').tgt,'FirstSecond'));
test('merge preserves both formatting runs and both histories',()=>{
 const r=Ops.merge(original,{...original,src:'丙',tgt:'Third',tgtRuns:[{text:'Third',underline:true}],comments:[{text:'Another'}]});assert.ok(r.tgtRuns.some(r=>r.underline));assert.ok(r.alignmentHistory.some(h=>h.comments.some(c=>c.text==='Another')));
});
test('backup keeps structured history safely and strips nested history',()=>{
 const parts=Ops.split(original,3,7,'backup');parts[0].alignmentHistory[0].alignmentHistory=[original];parts[0].alignmentHistory[0].html='<script>bad</script>';
 const data=IO.sanitizeBackup({tm:[],terms:[],projects:[{name:'P',segments:parts}]}).projects[0].segments;
 assert.equal(data[0].splitLink.id,'backup');assert.equal(data[0].alignmentHistory[0].comments[0].text,'Keep comment');assert.deepEqual(data[0].alignmentHistory[0].alignmentHistory,[]);assert.ok(!data[0].alignmentHistory[0].html);assert.equal(Ops.merge(...data).tgt,original.tgt);
});
test('more than 20 revisions / 50 comments no longer silently disappear',()=>{
 const s={...original,revisions:Array.from({length:21},(_,i)=>({text:'V'+i})),comments:Array.from({length:51},(_,i)=>({text:'C'+i}))};
 const result=IO.sanitizeBackup({tm:[],terms:[],projects:[{name:'P',segments:[s]}]}).projects[0].segments[0];assert.equal(result.revisions.length,21);assert.equal(result.comments.length,51);
});
test('nested splits and merges preserve word boundaries and paragraph export',()=>{
 const [a,b]=Ops.split({...original,tgt:'FirstSecondThird',tgtRuns:[]},3,5,'outer');
 const [b1,b2]=Ops.split({...b,src:'乙句。丙句。'},3,6,'inner');
 const parts=[a,b1,b2];
 assert.equal(parts.map((s,i)=>(i?Ops.targetSeparator(parts[i-1],s):'')+s.tgt).join(''),'FirstSecondThird');
 assert.equal(Ops.merge(Ops.merge(a,b1),b2).tgt,'FirstSecondThird');
 const restored=IO.sanitizeBackup({tm:[],terms:[],projects:[{name:'P',segments:parts}]}).projects[0].segments;
 assert.equal(restored[0].joinNext,true);assert.equal(restored[1].joinNext,true);
});
test('normal target separators retain whitespace without duplication',()=>{
 assert.equal(Ops.targetSeparator({tgt:'First. '},{tgt:'Second.'}),'');
 assert.equal(Ops.targetSeparator({tgt:'First.'},{tgt:'Second.'}),' ');
});
console.log(count+' segment operation tests passed');
