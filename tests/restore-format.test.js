/* Backup formatting must stay aligned with canonical text and never retain HTML. */
'use strict';
const assert = require('node:assert/strict');
const IO = require('../js/io.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('✓ ' + name);
}
function restore(segment) {
  return IO.sanitizeBackup({ tm: [], terms: [], projects: [{ name: 'P', segments: [{ src: '原文', ...segment }] }] }).projects[0].segments[0];
}
const textOf = runs => runs.map(run => run.text).join('');

test('legacy plain backups acquire plain structured runs', () => {
  const result = restore({ tgt: 'Legacy translation', revisions: [{ text: 'Older translation' }] });
  assert.deepEqual(result.tgtRuns, [{ text: 'Legacy translation' }]);
  assert.deepEqual(result.revisions[0].runs, [{ text: 'Older translation' }]);
});

test('all supported styles survive JSON backup round trip', () => {
  const runs = [
    { text: 'Bold', bold: true }, { text: 'Italic', italic: true },
    { text: 'Underline', underline: true }, { text: 'Up', superscript: true },
    { text: 'Down', subscript: true }
  ];
  const result = restore(JSON.parse(JSON.stringify({ tgt: textOf(runs), tgtRuns: runs, revisions: [{ text: textOf(runs), runs }] })));
  assert.deepEqual(result.tgtRuns, runs);
  assert.deepEqual(result.revisions[0].runs, runs);
});

test('unknown executable fields and HTML are not copied into run metadata', () => {
  const runs = [{ text: '<img src=x onerror=alert(1)>', bold: true, html: '<script>bad()</script>', onclick: 'bad()', style: 'background:url(bad)', id: 'evil' }];
  const result = restore({ tgt: textOf(runs), tgtRuns: runs, revisions: [{ text: textOf(runs), runs }] });
  const expected = [{ text: textOf(runs), bold: true }];
  assert.deepEqual(result.tgtRuns, expected);
  assert.deepEqual(result.revisions[0].runs, expected);
});

test('mismatched formatting falls back to canonical plain text', () => {
  const result = restore({ tgt: 'Actual', tgtRuns: [{ text: 'Different', bold: true }], revisions: [{ text: 'Old', runs: [{ text: 'Wrong', italic: true }] }] });
  assert.deepEqual(result.tgtRuns, [{ text: 'Actual' }]);
  assert.deepEqual(result.revisions[0].runs, [{ text: 'Old' }]);
});

test('target length cap cannot leave runs containing untruncated text', () => {
  const text = 'x'.repeat(20001);
  const result = restore({ tgt: text, tgtRuns: [{ text, bold: true }], revisions: [{ text, runs: [{ text, italic: true }] }] });
  assert.equal(result.tgt.length, 20000);
  assert.deepEqual(result.tgtRuns, [{ text: result.tgt }]);
  assert.deepEqual(result.revisions[0].runs, [{ text: result.revisions[0].text }]);
});

test('malformed formatting is discarded instead of changing text', () => {
  for (const runs of [null, 'HTML', {}, [{ text: 123 }], [null]]) {
    const result = restore({ tgt: 'Safe', tgtRuns: runs });
    assert.deepEqual(result.tgtRuns, [{ text: 'Safe' }]);
  }
});

console.log(`${passed} restore-format tests passed`);
