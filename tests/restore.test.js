/* Node tests for backup sanitization (io.sanitizeBackup) and JSONL import path. */
const IO = require('../js/io.js');
const Core = require('../js/core.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

/* --- structure validation --- */
ok((() => { try { IO.sanitizeBackup(null); return false; } catch (e) { return true; } })(), 'sanitize: null throws');
ok((() => { try { IO.sanitizeBackup({}); return false; } catch (e) { return /缺少 tm\/terms/.test(e.message); } })(), 'sanitize: missing tm/terms throws');

/* --- id stripping (cross-browser overwrite fix) --- */
const raw = {
  tm: [{ id: 999, project: 'P', src: '青花瓷是代表性产品。', tgt: 'Blue-and-white porcelain is representative.', srcNorm: 'TAMPERED', bigrams: ['bad'], note: 'n', origin: 'o', date: 'd', prevNorm: 'p' }],
  terms: [{ id: 777, project: 'P', zh: '<img src=x onerror=window.__xss=1>', en: 'malware', note: 'n' }],
  projects: [{ name: 'P', segments: [{ src: '段落。', tgt: 'Para.', status: 'translated', para: 0, bestScore: 88, matches: [{ id: 5, score: 88, src: 's', tgt: 't', note: 'n', origin: 'o' }] }] }]
};
const clean = IO.sanitizeBackup(raw, { defaultProject: '当前项目' });
ok(clean.tm.length === 1 && !('id' in clean.tm[0]), 'sanitize: tm id stripped (no overwrite possible)');
ok(clean.terms.length === 1 && !('id' in clean.terms[0]), 'sanitize: term id stripped');
ok(clean.tm[0].srcNorm === Core.normalizeCJK('青花瓷是代表性产品。'), 'sanitize: srcNorm recomputed (tamper ignored)');
ok(Array.isArray(clean.tm[0].bigrams) && clean.tm[0].bigrams.length > 0, 'sanitize: bigrams recomputed');
ok(clean.projects[0].segments[0].matches.length === 1 && !('id' in clean.projects[0].segments[0].matches[0]), 'sanitize: match ids stripped');
ok(clean.projects[0].segments[0].bestScore === 88, 'sanitize: bestScore kept');

/* --- type junk filtered --- */
const junk = { tm: [null, 'str', { src: 42 }, { src: '好句子。', tgt: 123 }, { src: '好句子。', tgt: 'ok translation' }], terms: [null, { zh: 1 }, { zh: '真术语', en: 'real term' }], projects: 'not-array' };
const clean2 = IO.sanitizeBackup(junk, { defaultProject: 'X' });
ok(clean2.tm.length === 1 && clean2.tm[0].tgt === 'ok translation', 'sanitize: junk tm rows filtered (non-string tgt dropped)');
ok(clean2.terms.length === 1 && clean2.terms[0].zh === '真术语', 'sanitize: junk term rows filtered');
ok(Array.isArray(clean2.projects) && clean2.projects.length === 0, 'sanitize: non-array projects → empty');

/* --- length caps + default project --- */
const big = { tm: [{ project: '', src: 'x'.repeat(30000), tgt: 'y'.repeat(30000) }], terms: [{ zh: 'z'.repeat(1000), note: 'n'.repeat(9000) }] };
const clean3 = IO.sanitizeBackup(big, { defaultProject: '导入备份' });
ok(clean3.tm[0].src.length === 20000 && clean3.tm[0].tgt.length === 20000, 'sanitize: length caps applied');
ok(clean3.tm[0].project === '导入备份', 'sanitize: default project assigned');
ok(clean3.terms[0].zh.length === 500 && clean3.terms[0].note.length === 4000, 'sanitize: term caps applied');

/* --- JSONL import path round-trip (README-claimed feature) --- */
const lines = [
  JSON.stringify({ id: 'TU0001', zh: '目 录', en: 'Table of Contents', chapter: 'toc' }),
  JSON.stringify({ id: 'TU0002', zh: '序 耿宝昌', en: 'Preface', chapter: 'toc' }),
  'not-json-line',
  JSON.stringify({ zh: '只有中文没有英文' }) // filtered: no en
];
const objs = IO.parseJSONL(lines.join('\n'));
ok(objs.length === 3, `parseJSONL: skips bad lines (got ${objs.length})`);
const tmRows = IO.jsonlToTMRows(objs, '测试项目');
ok(tmRows.length === 2, `jsonlToTMRows: zh+en pairs only (got ${tmRows.length})`);
ok(tmRows[0].src === '目 录' && tmRows[0].tgt === 'Table of Contents', 'jsonlToTMRows: field mapping');
ok(tmRows[0].project === '测试项目' && tmRows[0].note.includes('章节:toc'), 'jsonlToTMRows: project + provenance');
ok(tmRows[0].bigrams.length > 0 && tmRows[0].srcNorm.length > 0, 'jsonlToTMRows: derived fields computed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
