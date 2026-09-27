const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Revision = require('../js/revision-plan.js');
const Core = require('../js/core.js');
const Diff = require('../js/diff.js');
let passed = 0;
function test(name, fn) { fn(); passed++; }
const segments = [{ src: '甲段', tgt: 'first' }, { src: '乙段', tgt: 'middle' }, { src: '甲段', tgt: 'last' }];
const pairs = [{ zh: '甲段', en: 'first revised' }, { zh: '乙段', en: 'middle' }, { zh: '甲段', en: 'last revised' }];
test('Repeated paragraphs map to separate occurrences', () => {
  const result = Revision.buildPlan(segments, pairs);
  assert.deepEqual(result.plan.map(p => p.idx), [0, 2]);
  assert.equal(result.unchanged, 1);
});
test('Partial repeated source is rejected', () => {
  assert.throws(() => Revision.buildPlan(segments, [pairs[0]]), /无法唯一匹配/);
});
test('Too many duplicate rows cannot overwrite a unique segment', () => {
  assert.throws(() => Revision.buildPlan([segments[0]], [pairs[0], pairs[2]]), /无法唯一匹配/);
});
test('Unchanged occurrence still consumes its own position', () => {
  const result = Revision.buildPlan(segments, [{ zh: '甲段', en: 'first' }, pairs[2]]);
  assert.deepEqual(result.plan.map(p => p.idx), [2]);
});
test('Blank translation still preserves occurrence identity for comments', () => {
  const result = Revision.buildPlan(segments, [{ zh: '甲段', en: '' }, pairs[2]], [{ pairIndex: 0, text: 'note' }]);
  assert.deepEqual(result.plan.map(p => p.idx), [2]);
  assert.equal(result.comments[0].idx, 0);
});
test('Multiple comments on one row do not consume another occurrence', () => {
  const result = Revision.buildPlan(segments, pairs, [
    { pairIndex: 0, text: 'note1' }, { pairIndex: 0, text: 'note2' }, { pairIndex: 2, text: 'note3' }
  ]);
  assert.deepEqual(result.comments.map(c => c.idx), [0, 0, 2]);
});
test('Comment-only import is retained', () => {
  const result = Revision.buildPlan([segments[1]], [{ zh: '乙段', en: 'middle' }], [{ pairIndex: 0, text: 'note' }]);
  assert.equal(result.plan.length, 0);
  assert.equal(result.comments.length, 1);
});
test('Already imported comments are not re-added', () => {
  const result = Revision.buildPlan([{ src: '乙段', tgt: 'middle', comments: [{ text: 'note', author: '批注' }] }],
    [{ zh: '乙段', en: 'middle' }], [{ pairIndex: 0, text: 'note' }]);
  assert.equal(result.comments.length, 0);
});
test('New repeated rows and their comments retain separate targets', () => {
  const result = Revision.buildPlan([], [pairs[0], pairs[2]], [{ pairIndex: 1, text: 'last note' }]);
  assert.deepEqual(result.plan.map(p => p.idx), [0, 1]);
  assert.equal(result.comments[0].idx, 1);
});
test('Unmappable comments fail instead of disappearing silently', () => {
  assert.throws(() => Revision.buildPlan([], [{ zh: '甲段', en: '' }], [{ pairIndex: 0, text: 'note' }]), /无法定位/);
});
test('Planning does not mutate project or input', () => {
  const before = JSON.stringify({ segments, pairs });
  Revision.buildPlan(segments, pairs);
  assert.equal(JSON.stringify({ segments, pairs }), before);
});

// Exercise the actual UI preview handler with lightweight DOM stand-ins, including async races.
async function previewTests() {
  const code = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const begin = code.indexOf('    let revPending = null;');
  const end = code.indexOf("    $('#btnRevCommit').onclick", begin);
  const elements = {
    '#dlgRevision': { addEventListener() {} }, '#revFile': { files: [] },
    '#revPreview': {}, '#revAuthor': { value: '' }, '#revLabel': { value: '' }, '#btnRevCommit': { disabled: true }
  };
  const state = { project: 'P', segments: [{ src: '乙段', tgt: 'middle' }] };
  const setup = new Function('$', 'state', 'Core', 'Diff', 'esc', 'window', 'revParsePairs',
    code.slice(begin, end) + '\nreturn () => revPending;');
  const pending = setup(s => elements[s], state, Core, Diff, Core.escapeHtml, { MiniCatRevision: Revision }, f => f.parse());
  const choose = f => { elements['#revFile'].files = [f]; return elements['#revFile'].onchange(); };
  const good = { name: 'good.docx', parse: async () => ({ pairs: [{ zh: '乙段', en: 'middle' }], comments: [{ pairIndex: 0, text: 'note' }], note: 'docx' }) };
  await choose(good);
  assert.equal(elements['#btnRevCommit'].disabled, false);
  passed++;
  await choose({ name: 'bad.docx', parse: async () => { throw new Error('Invalid file'); } });
  assert.equal(pending(), null);
  assert.equal(elements['#btnRevCommit'].disabled, true);
  passed++;
  let resolveSlow;
  const slow = choose({ name: 'slow.docx', parse: () => new Promise(r => { resolveSlow = r; }) });
  await choose(good);
  resolveSlow({ pairs: [{ zh: '乙段', en: 'wrong late result' }], comments: [], note: 'slow' });
  await slow;
  assert.equal(pending().sourceFile, 'good.docx');
  assert.equal(pending().plan.length, 0);
  passed++;
  console.log(`${passed} passed, 0 failed`);
}
previewTests().catch(err => { console.error(err); process.exitCode = 1; });
