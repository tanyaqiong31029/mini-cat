/* Isolated real-browser regressions; never opens an existing browser profile. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('@playwright/test');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const data = await fs.readFile(file);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(data);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {});
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept(dialog.type() === 'prompt' ? 'New Project' : undefined));
    await page.goto('http://127.0.0.1:' + server.address().port);
    const ready = () => page.waitForFunction(() => document.querySelector('#log').textContent.includes('就绪'));
    await ready();
    await page.locator('#btnImportSource').click();
    await page.locator('#srcPaste').fill('甲段落内容。\n乙段落内容。\n甲段落内容。');
    await page.locator('#srcSegMode').selectOption('paragraph');
    await page.locator('#btnSourceLoad').click();
    await page.waitForFunction(() => document.querySelectorAll('.seg-tgt').length === 3);
    const oldName = await page.locator('#projSelect').inputValue();
    // Enqueue an older write, then edit+new-project before debounce; latest must win.
    await page.evaluate(() => {
      window.auditBackup = null;
      MiniCatIO.download = (_name, data) => { window.auditBackup = JSON.parse(data); };
      const ta = document.querySelector('.seg-tgt');
      ta.value = 'older'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btnBackup').click();
      ta.value = 'latest before new'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#projNew').click();
    });
    await page.waitForFunction(() => document.querySelector('#projSelect').value === 'New Project');
    assert.equal(await page.evaluate(n => MiniCatDB.Projects.get(n).then(p => p.segments[0].tgt), oldName), 'latest before new');
    assert.equal(await page.locator('.seg-tgt').count(), 0);
    console.log('PASS pending edit and save queue before new project');

    // A historical string ID is untrusted but must remain inert and usable.
    await page.evaluate(async () => {
      await MiniCatDB.Terms.addMany([{ id: 'x"><img src=x onerror="window.auditXss=1">', project: 'New Project', zh: 'legacy term', en: 'legacy' }]);
    });
    await page.reload(); await ready();
    assert.equal(await page.locator('#termList img').count(), 0);
    assert.equal(await page.evaluate(() => window.auditXss || 0), 0);
    assert.equal(await page.locator('#termList .webref-go').getAttribute('data-id'), 'x"><img src=x onerror="window.auditXss=1">');
    console.log('PASS legacy ID cannot inject DOM/script');

    await page.evaluate(() => {
      window.searches = [];
      MiniCatWebRef.lookupAll = (zh, en) => new Promise((resolve, reject) => searches.push({ zh, en, resolve, reject }));
      window.startSearch = value => {
        const input = document.querySelector('#webrefInput');
        input.value = value; input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      };
      window.searchResult = title => ({ results: [{ source: 'test', hits: [{ title, url: 'https://example.com/' }] }], links: [] });
      startSearch('旧查询'); startSearch('新查询');
      searches[1].resolve(searchResult('NEW'));
    });
    await page.waitForFunction(() => document.querySelector('.hit-title')?.textContent === 'NEW');
    await page.evaluate(async () => { searches[0].resolve(searchResult('OLD')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.locator('.hit-title').textContent(), 'NEW');
    await page.evaluate(() => { startSearch('失败旧查询'); startSearch('成功新查询'); searches[3].resolve(searchResult('NEWER')); });
    await page.waitForFunction(() => document.querySelector('.hit-title')?.textContent === 'NEWER');
    await page.evaluate(async () => { searches[2].reject(new Error('old failure')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.locator('.hit-title').textContent(), 'NEWER');
    await page.evaluate(async () => { startSearch('待返回'); const input = document.querySelector('#webrefInput'); input.value = ''; input.dispatchEvent(new Event('input')); searches[4].resolve(searchResult('STALE')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.locator('.hit-title').count(), 0);
    console.log('PASS reverse response, stale error and cleared query');

    // Revision import must target A1 and A2 separately, keeping B in the middle.
    await page.locator('#projSelect').selectOption(oldName);
    await page.waitForFunction(() => document.querySelectorAll('.seg-tgt').length === 3);
    await page.locator('#btnImportRevision').click();
    await page.locator('#revFile').setInputFiles({ name: 'revisions.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('中文\t英文\n甲段落内容。\tFirst A\n乙段落内容。\tMiddle B\n甲段落内容。\tSecond A') });
    await page.waitForFunction(() => !document.querySelector('#btnRevCommit').disabled);
    await page.locator('#btnRevCommit').click();
    await page.waitForFunction(() => !document.querySelector('#dlgRevision').open);
    await page.waitForFunction(() => JSON.stringify([...document.querySelectorAll('.seg-tgt')].map(n => n.value)) === JSON.stringify(['First A', 'Middle B', 'Second A']));
    assert.deepEqual(await page.locator('.seg-tgt').evaluateAll(nodes => nodes.map(n => n.value)), ['First A', 'Middle B', 'Second A']);
    console.log('PASS repeated paragraph revision maps by occurrence');
    await page.locator('#btnImportRevision').click();
    await page.locator('#revFile').setInputFiles({ name: 'ambiguous.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('中文\t英文\n甲段落内容。\tAmbiguous A') });
    await page.waitForFunction(() => !document.querySelector('#revPreview').textContent.includes('解析并匹配中'));
    assert.equal(await page.locator('#btnRevCommit').isDisabled(), true);
    await page.evaluate(() => document.querySelector('#dlgRevision').close());
    await page.evaluate(async () => {
      const originalGet = MiniCatDB.Projects.get;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      MiniCatDB.Projects.get = async (...args) => { await gate; return originalGet(...args); };
      const ta = document.querySelector('.seg-tgt');
      ta.value = 'must not return after wipe'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btnBackup').click();
      document.querySelector('#btnWipe').click();
      release();
      MiniCatDB.Projects.get = originalGet;
    });
    await page.waitForFunction(() => document.querySelectorAll('.seg-tgt').length === 0);
    assert.equal(await page.evaluate(n => MiniCatDB.Projects.get(n).then(p => p.segments.length), oldName), 0);
    console.log('PASS queued save cannot undo workspace clear');
    assert.deepEqual(pageErrors, []);
    console.log('PASS ambiguous repeated paragraph is blocked; no browser errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
