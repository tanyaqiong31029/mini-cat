const assert=require('node:assert/strict');
const C=require('../js/term-candidates.js');
const pairs=[
 {src:'边缘计算降低延迟。',tgt:'Edge computing reduces latency.'},
 {src:'边缘计算改善带宽。',tgt:'Edge computing improves bandwidth.'},
 {src:'我们采用边缘计算。',tgt:'We use edge computing.'},
 {src:'边缘计算支持设备。',tgt:'Edge computing supports devices.'}
];
const result=C.scan(pairs,[],2);
assert.ok(result.candidates.some(c=>c.term==='边缘计算'));
assert.equal(result.stats.eligible,4);
assert.ok(result.warning);
assert.ok(!C.scan(pairs,[{zh:'边缘计算'}],2).candidates.some(c=>c.term==='边缘计算'));
assert.throws(()=>C.scan(pairs.slice(0,2),[],2),/3/);
assert.deepEqual(C.acceptedRows(result.candidates,[{term:'边缘计算',accept:false,tgt:'edge computing'}]),[]);
assert.throws(()=>C.acceptedRows(result.candidates,[{term:'边缘计算',accept:true,tgt:''}]),/译名/);
assert.throws(()=>C.acceptedRows(result.candidates,[{term:'未知',accept:true,tgt:'unknown'}]),/不存在/);
assert.equal(C.acceptedRows(result.candidates,[{term:'边缘计算',accept:true,tgt:'edge computing'}])[0].status,'confirmed');
assert.throws(()=>C.scan([{src:'你好',tgt:'你好'},{src:'再见',tgt:'再见'},{src:'谢谢',tgt:'谢谢'}],[],2),/语言对/);
console.log('10 candidate extraction assertions passed');
