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
    const ready = () => page.waitForFunction(() => document.querySelector('#log').textContent.includes('就绪'), { polling: 100 });
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
      ta.textContent = 'older'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btnBackup').click();
      ta.textContent = 'latest before new'; ta.dispatchEvent(new Event('input', { bubbles: true }));
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
    await page.waitForFunction(() => JSON.stringify([...document.querySelectorAll('.seg-tgt')].map(n => n.textContent)) === JSON.stringify(['First A', 'Middle B', 'Second A']));
    assert.deepEqual(await page.locator('.seg-tgt').evaluateAll(nodes => nodes.map(n => n.textContent)), ['First A', 'Middle B', 'Second A']);
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
      ta.textContent = 'must not return after wipe'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btnBackup').click();
      document.querySelector('#btnWipe').click();
      release();
      MiniCatDB.Projects.get = originalGet;
    });
    await page.waitForFunction(() => document.querySelectorAll('.seg-tgt').length === 0);
    assert.equal(await page.evaluate(n => MiniCatDB.Projects.get(n).then(p => p.segments.length), oldName), 0);
    console.log('PASS queued save cannot undo workspace clear');

    // Rich text edit -> save -> reload -> backup restore -> actual DOCX exports.
    await page.evaluate(async n => {
      const p = await MiniCatDB.Projects.get(n);
      p.segments = [{src:'格式测试。',tgt:'Bold italic 2 x',status:'translated',para:0}];
      await MiniCatDB.Projects.put(p);
    }, oldName);
    await page.reload(); await ready();
    const selectText = (start,end) => page.evaluate(([a,b])=>MiniCatRichText.restoreSelection(document.querySelector('.seg-tgt'),a,b),[start,end]);
    await selectText(0,4); await page.locator('[data-format=bold]').click();
    await selectText(5,11); await page.keyboard.press('Control+i');
    await selectText(0,4); await page.keyboard.press('Control+u');
    await selectText(12,13); await page.locator('[data-format=superscript]').click();
    await selectText(14,15); await page.locator('[data-format=subscript]').click();
    assert.equal(await page.locator('.seg-tgt strong').textContent(),'Bold');
    assert.equal(await page.locator('.seg-tgt em').textContent(),'italic');
    assert.equal(await page.locator('.seg-tgt sup').textContent(),'2');
    assert.equal(await page.locator('.seg-tgt sub').textContent(),'x');
    if (process.env.MINICAT_QA_DIR) {
      await fs.mkdir(process.env.MINICAT_QA_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.MINICAT_QA_DIR,'rich-editor.png'),fullPage:true});
    }
    await page.evaluate(()=>{window.capturedBackup=null;MiniCatIO.download=(_n,data)=>{window.capturedBackup=JSON.parse(data);};document.querySelector('#btnBackup').click();});
    await page.waitForFunction(()=>window.capturedBackup);
    const backup = await page.evaluate(()=>window.capturedBackup);
    await page.reload(); await ready();
    assert.equal(await page.locator('.seg-tgt strong').textContent(),'Bold');
    await page.locator('#btnWipe').click();
    await page.waitForFunction(()=>!document.querySelector('.seg-tgt'));
    await page.locator('#fileRestore').setInputFiles({name:'rich.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
    await page.waitForFunction(()=>document.querySelector('#log').textContent.includes('备份恢复完成'));
    assert.equal(await page.locator('.seg-tgt sub').textContent(),'x');
    await selectText(0,4); await page.locator('[data-format=clear]').click();
    assert.equal(await page.locator('.seg-tgt strong').count(),0);
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('.seg-tgt strong').count(),1);
    await page.evaluate(()=>{window.exports={};MiniCatIO.download=(n,data)=>window.exports[n]=typeof data==='string'?data:Array.from(data);});
    await page.locator('#btnExport').click();
    await page.locator('#expRange').selectOption('all');
    for (const id of ['btnDocPure','btnBiParaDocx','btnSentDocx','btnExpBilingual']) await page.locator('#'+id).click();
    const exports = await page.evaluate(()=>window.exports);
    const Zip = require('../js/zip.js');
    for (const [name,data] of Object.entries(exports)) {
      if(name.endsWith('.docx')) {
        const xml=await Zip.extractText(Uint8Array.from(data),'word/document.xml');
        for(const marker of ['<w:b/>','<w:i/>','<w:u w:val="single"/>','w:val="superscript"','w:val="subscript"'])assert.ok(xml.includes(marker),name+':'+marker);
      } else { assert.ok(data.includes('<strong>Bold</strong>')); assert.ok(data.includes('<em>italic</em>')); }
    }
    await page.evaluate(()=>document.querySelector('#dlgExport').close());
    await selectText(0,4);
    await page.evaluate(()=>{
      const data=new DataTransfer();data.setData('text/plain','safe');data.setData('text/html','<img src=x onerror="window.pasteXss=1">');
      document.querySelector('.seg-tgt').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    });
    assert.equal(await page.locator('.seg-tgt img').count(),0);
    assert.equal(await page.evaluate(()=>window.pasteXss||0),0);
    console.log('PASS rich editing, shortcuts, undo, persistence, restore, safe paste and all delivery DOCX formats');

    // Worker scans every completed pair; human selection is required before insertion.
    await page.locator('#projSelect').selectOption('New Project');
    await page.waitForFunction(()=>!document.querySelector('.seg-tgt'));
    await page.evaluate(async n=>{
      const p=await MiniCatDB.Projects.get(n);
      p.segments=[['边缘计算降低延迟。','Edge computing reduces latency.'],['边缘计算改善带宽。','Edge computing improves bandwidth.'],['我们采用边缘计算。','We use edge computing.'],['边缘计算支持设备。','Edge computing supports devices.']].map(([src,tgt],i)=>({src,tgt,para:i}));
      await MiniCatDB.Projects.put(p);
    },oldName);
    await page.locator('#projSelect').selectOption(oldName);
    await page.waitForFunction(()=>document.querySelectorAll('.seg-tgt').length===4);
    await page.locator('.side-tab[data-tab=terms]').click();
    await page.locator('#btnTermExtract').click();
    await page.waitForFunction(()=>document.querySelectorAll('.candidate-row').length>0).catch(async error=>{console.error('Candidate diagnostic:',await page.locator('#candidateStatus').textContent(),pageErrors);throw error;});
    if (process.env.MINICAT_QA_DIR) await page.screenshot({path:path.join(process.env.MINICAT_QA_DIR,'term-candidates.png'),fullPage:true});
    assert.equal(await page.locator('.candidate-accept:checked').count(),0);
    const row=page.locator('.candidate-row').filter({has:page.locator('label',{hasText:'边缘计算'})}).first();
    await row.locator('.candidate-en').fill('edge computing');
    await row.locator('.candidate-accept').check();
    await page.locator('#btnCandidateCommit').click();
    await page.waitForFunction(()=>!document.querySelector('#dlgTermCandidates').open);
    assert.equal(await page.evaluate(async n=>(await MiniCatDB.Terms.all(n)).filter(t=>t.zh==='边缘计算'&&t.en==='edge computing').length,oldName),1);
    await page.locator('#btnTermExtract').click();
    await page.waitForFunction(()=>document.querySelector('#candidateStatus').textContent.includes('待复核'));
    assert.equal(await page.locator('.candidate-row label').filter({hasText:'边缘计算 ·'}).count(),0);
    console.log('PASS local extraction, explicit human approval, term persistence and duplicate exclusion');
    await page.evaluate(()=>document.querySelector('#dlgTermCandidates').close());
    await page.locator('#projSelect').selectOption('New Project');
    await page.waitForFunction(()=>!document.querySelector('.seg-tgt'));
    await page.evaluate(async n=>{
      const p=await MiniCatDB.Projects.get(n);
      p.segments=[{src:'甲句。乙句。',tgt:'First. Second.',tgtRuns:[{text:'First.',bold:true},{text:' Second.',italic:true}],status:'translated',para:0,key0:'split-test@0',revisions:[{v:'V1',author:'Reviewer',text:'Original revision'}],comments:[{author:'Reviewer',text:'Original comment'}]},{src:'丙句。',tgt:'Third.',status:'untranslated',para:1,key0:'split-test@1'}];
      await MiniCatDB.Projects.put(p);
    },oldName);
    await page.locator('#projSelect').selectOption(oldName);
    await page.waitForFunction(()=>document.querySelectorAll('.seg-tgt').length===2);
    const tmBefore=await page.evaluate(async n=>(await MiniCatDB.TM.all(n)).length,oldName);
    await page.locator('.split-seg').first().click();
    assert.equal(await page.locator('#btnSegmentCommit').isDisabled(),true);
    const chooseCuts=()=>page.evaluate(()=>{
      const source=document.querySelector('#splitSource'),target=document.querySelector('#splitTarget');
      source.focus();source.setSelectionRange(3,3);source.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      target.focus();target.setSelectionRange(7,7);target.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    });
    await chooseCuts();
    assert.equal(await page.locator('#segmentEditPreview .pair-preview').count(),2);
    if(process.env.MINICAT_QA_DIR)await page.screenshot({path:path.join(process.env.MINICAT_QA_DIR,'split-pairs.png'),fullPage:true});
    await page.locator('#btnSegmentCommit').click();
    await page.waitForFunction(()=>document.querySelectorAll('.seg-tgt').length===3&&!document.body.inert);
    assert.deepEqual(await page.locator('.seg .seg-src').evaluateAll(nodes=>nodes.map(n=>n.textContent)),['甲句。','乙句。','丙句。']);
    assert.equal(await page.locator('.seg-tgt').nth(0).locator('strong').textContent(),'First.');
    assert.equal(await page.locator('.seg-tgt').nth(1).locator('em').textContent(),'Second.');
    assert.equal(await page.evaluate(async n=>(await MiniCatDB.Projects.get(n)).segments[0].status,oldName),'untranslated');
    await page.locator('.pair-history').first().click();
    assert.ok((await page.locator('.seg-extra').first().textContent()).includes('Original comment'));
    assert.ok((await page.locator('.seg-extra').first().textContent()).includes('Original revision'));
    await page.reload();await ready();
    assert.equal(await page.locator('.seg-tgt').count(),3);
    assert.equal(await page.locator('#btnPairUndo').isDisabled(),true);
    // Split boundaries must remain exact in paragraph exports, not just the UI.
    await page.evaluate(()=>{window.pairExports={};MiniCatIO.download=(n,data)=>window.pairExports[n]=typeof data==='string'?data:Array.from(data);});
    await page.locator('#btnExport').click();
    await page.locator('#expRange').selectOption('all');
    await page.locator('#btnDocPureTxt').click();await page.locator('#btnDocPure').click();
    const pairExports=await page.evaluate(()=>window.pairExports);
    assert.equal(Object.entries(pairExports).find(([n])=>n.endsWith('.txt'))[1],'First. Second.\n\nThird.');
    const pairXml=await Zip.extractText(Uint8Array.from(Object.entries(pairExports).find(([n])=>n.endsWith('.docx'))[1]),'word/document.xml');
    assert.ok(pairXml.includes('<w:b/>'));assert.ok(pairXml.includes('<w:i/>'));
    await page.evaluate(()=>document.querySelector('#dlgExport').close());
    // Fail the adjusted write (after the original snapshot has been saved).
    await page.evaluate(()=>{
      // v1.9：句对调整的保存走 saveWithRev（版本 CAS），失败注入点随之迁移
      window.originalPairPut=MiniCatDB.Projects.saveWithRev;let calls=0;
      MiniCatDB.Projects.saveWithRev=async(...args)=>{if(++calls===2)throw new Error('Injected save failure');return window.originalPairPut(...args);};
    });
    await page.locator('.merge-seg').first().click();await page.locator('#btnSegmentCommit').click();
    await page.waitForFunction(()=>document.querySelectorAll('.seg-tgt').length===3&&!document.body.inert);
    assert.equal(await page.evaluate(async n=>(await MiniCatDB.Projects.get(n)).segments.length,oldName),3);
    assert.equal(await page.locator('#btnPairUndo').isDisabled(),true);
    await page.evaluate(()=>{MiniCatDB.Projects.saveWithRev=window.originalPairPut;});
    const mergeFirst=async()=>{
      await page.locator('.merge-seg').first().click();
      assert.equal(await page.locator('#splitControls').isVisible(),false);
      await page.locator('#btnSegmentCommit').click();
      await page.waitForFunction(()=>document.querySelectorAll('.seg-tgt').length===2&&!document.body.inert);
    };
    await mergeFirst();
    assert.equal(await page.locator('.seg-tgt').first().textContent(),'First. Second.');
    assert.equal(await page.locator('.seg-tgt strong').count(),1);
    assert.equal(await page.locator('.seg-tgt em').count(),1);
    await page.locator('#btnPairUndo').click();
    await page.waitForFunction(()=>document.querySelectorAll('.seg-tgt').length===3&&!document.body.inert);
    await mergeFirst();
    await page.locator('.seg-tgt').first().fill('Edited after merge');
    await page.locator('#btnPairUndo').click();
    assert.equal(await page.locator('.seg-tgt').first().textContent(),'Edited after merge');
    assert.equal(await page.locator('.seg-tgt').count(),2);
    assert.equal(await page.evaluate(async n=>(await MiniCatDB.TM.all(n)).length,oldName),tmBefore);
    console.log('PASS paired split/merge, formatting and history preservation, reload, undo and protection of later edits; TM unchanged');
    assert.deepEqual(pageErrors, []);
    console.log('PASS ambiguous repeated paragraph is blocked; no browser errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
