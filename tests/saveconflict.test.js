/* Node tests: 多标签页覆盖保护（Projects.saveWithRev 版本 CAS）。 */
require('fake-indexeddb/auto');
const DB = require('../js/db.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}

(async () => {
  // 标签页 A：首次保存（legacy 项目，rev 从 0 起）
  const a1 = await DB.Projects.saveWithRev('项目P', 0, { segments: [{ src: 'A1', tgt: 'a' }], updated: 't1' });
  ok(a1.ok && a1.newRev === 1, `tab A first save ok (got ${JSON.stringify(a1)})`);

  // 标签页 B 用过期版本号保存 → 冲突，不写入
  const b1 = await DB.Projects.saveWithRev('项目P', 0, { segments: [{ src: 'B1', tgt: 'b' }], updated: 't2' });
  ok(b1.ok === false && b1.conflict === true && b1.currentRev === 1, 'tab B stale rev → conflict');
  ok(b1.segments.length === 1 && b1.segments[0].src === 'A1', 'conflict report exposes other tab content');

  // A 的数据未被 B 覆盖
  const afterB = await DB.Projects.get('项目P');
  ok(afterB.segments[0].src === 'A1', 'A data intact after B conflict');

  // B 强制覆盖（expectedRev=null）→ rev 2
  const b2 = await DB.Projects.saveWithRev('项目P', null, { segments: [{ src: 'B2', tgt: 'b2' }], updated: 't3' });
  ok(b2.ok && b2.newRev === 2, 'forced save ok');

  // A 再用过期 rev 1 保存 → 冲突（currentRev 2）
  const a2 = await DB.Projects.saveWithRev('项目P', 1, { segments: [{ src: 'A2' }] });
  ok(a2.conflict === true && a2.currentRev === 2, 'stale A → conflict again');

  // A 接受合并提示后用 currentRev 保存 → 成功
  const a3 = await DB.Projects.saveWithRev('项目P', a2.currentRev, { segments: [{ src: 'A3' }] });
  ok(a3.ok && a3.newRev === 3, 'A saves with fresh rev');

  // 最终数据 = A3
  const final = await DB.Projects.get('项目P');
  ok(final.segments[0].src === 'A3' && final.rev === 3, 'final state consistent');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
