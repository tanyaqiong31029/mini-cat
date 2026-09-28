/* Node tests for webref.js pure helpers (links builder, snippet stripping). */
const Web = require('../js/webref.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

const links = Web.buildLinks('胎釉', 'body and glaze');
ok(links.length >= 7, `link count (got ${links.length})`);
ok(links.some(l => l.name.includes('术语在线') && l.url.includes('termonline.cn')), 'termonline link present');
ok(links.some(l => l.url.includes(encodeURIComponent('胎釉'))), 'zh term encoded into links');
ok(links.some(l => l.url.includes(encodeURIComponent('body and glaze')) || l.url.includes('body%20and%20glaze')), 'en term encoded into links');
ok(links.every(l => l.url.startsWith('https://')), 'all links https');
ok(links.some(l => l.name === 'Google 全部' && l.url.includes('www.google.com/search')), 'Google web link present');
ok(links.some(l => l.name === 'Google Books' && l.url.includes('tbm=bks')), 'Google Books link present');
ok(links.some(l => l.url.includes('ja.wikipedia.org')), 'ja.wikipedia site-search link present');
ok(links.some(l => l.url.includes('lit.kosh.or.jp')), 'Japanese scholar dictionary link present');
const ranked = Web.rankHits([
  { title: '尾崎行雄', snippet: '日本政治家' },
  { title: '尾崎洵盛', snippet: '日本の陶磁器研究家' }
], '尾崎洵盛');
ok(ranked[0].title === '尾崎洵盛' && ranked[0].exact === true, 'rankHits: exact match first');
ok(ranked[1].exact === false, 'rankHits: partial-name hit marked related');
ok(links.some(l => l.url.includes('site%3Adigicol.dpm.org.cn')), 'museum site-search link uses Bing site: operator');

ok(Web.stripHtml('<span class="searchmatch">青釉</span> 与 <b>胎</b>') === '青釉 与 胎', 'stripHtml removes tags');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
