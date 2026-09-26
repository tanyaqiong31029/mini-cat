/* Scale benchmark: ~10万字 scenario (4000 TM entries, 400 query segments). */
const Core = require('../js/core.js');
const NOUNS = ['青花瓷','釉里红','斗彩','粉彩','珐琅彩','青釉','白瓷','甜白','影青','玲珑瓷'];
const VERBS = ['是','成为','代表','体现','反映','标志着','构成了','展现了'];
const ADJ = ['最重要的','独特的','典型的','罕见的','精美的','富有代表性的'];
function sent(i){const n=NOUNS[i%10],v=VERBS[(i*7)%8],a=ADJ[(i*3)%6];return `第${i}章：${n}${v}景德镇窑${a}产品，其工艺特征与装饰手法体现了元代制瓷技术的整体水平。`;}
const tm=[];
for(let i=0;i<4000;i++){const src=sent(i);tm.push({id:i,src,srcNorm:Core.normalizeCJK(src),grams:[...Core.bigrams(src)],tgt:'English target '+i});}
const idx=Core.createTMIndex(tm);
const queries=[];for(let i=0;i<400;i++){queries.push(sent(1000+i).replace('体现','体现着'));} // slight perturbation
let t0=Date.now(),counts={exact:0,hi:0};
for(const q of queries){
  const hits=Core.findMatches(q,tm,idx,50,5);
  if(hits.length){const b=Core.matchBand(hits[0].score).key;if(b==='exact')counts.exact++;if(b==='hi'||b==='near')counts.hi++;}
}
console.log(`TM=${tm.length} queries=${queries.length} total=${Date.now()-t0}ms avg=${((Date.now()-t0)/queries.length).toFixed(1)}ms/seg`,counts);
