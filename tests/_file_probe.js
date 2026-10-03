const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('@playwright/test');
(async () => {
  const root = '/Users/tanyaqiong/Desktop/瓷器中国/00 样章 试译和术语/其他/mini-cat';
  const server = { close(){}, address(){ return {port:8765}; } };
if (false) const unused = async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try { const data = await fs.readFile(file);
      const ext = path.extname(file).toLowerCase();
      const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
      res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
      res.end(data);
    } catch (_) { res.writeHead(404); res.end(); }
  });
  // server already on 8765
  const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR:', e.message.slice(0, 150)));
  await page.goto('http://127.0.0.1:8765');
  await page.waitForTimeout(13000);

  // 用你的真实 docx 文件测试解析
  const testFile = process.argv[2] || '../00 谭雅琼/Porcelain_China_Sec6-8_Bilingual_V1_谭雅琼底稿_20261001.docx';
  const fileBuf = await fs.readFile(process.argv[2] || '/Users/tanyaqiong/Desktop/瓷器中国/00 谭雅琼/Porcelain_China_Sec6-8_Bilingual_V1_谭雅琼底稿_20261001.docx');
  const r = await page.evaluate(async (bufArr) => {
    const buf = new Uint8Array(bufArr);
    const steps = {};
    try {
      // 1) docxToBlocks
      const parsed = await MiniCatOffice.docxToBlocks(buf);
      steps.paragraphs = parsed.paragraphs.length;
      steps.tables = parsed.tables.length;
      steps.first5 = parsed.paragraphs.filter(p=>p.trim()).slice(0,5);
      // 2) sniffDocxParagraphs
      const sniff = MiniCatOffice.sniffDocxParagraphs(parsed.paragraphs);
      steps.sniffMode = sniff ? sniff.mode : null;
      steps.sniffPairs = sniff ? sniff.pairs.length : 0;
      steps.sniffFirst = sniff && sniff.pairs[0] ? JSON.stringify(sniff.pairs[0]).slice(0,80) : null;
      // 3) isCJK check
      steps.cjkCounts = parsed.paragraphs.filter(p=>p.trim()).slice(0,10).map(p => ({
        text: p.slice(0,25),
        isCJK: MiniCatOffice.isCJK(p)
      }));
    } catch(e) { steps.error = e.message; }
    return steps;
  }, Array.from(fileBuf));
  console.log(JSON.stringify(r, null, 1));
  await browser.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
