const assert=require('node:assert/strict');
const Write=require('../js/officewrite.js'), Zip=require('../js/zip.js');
(async()=>{
  const runs=[{text:'Bold',bold:true},{text:'Italic',italic:true},{text:'Underline',underline:true},{text:'2',superscript:true},{text:'3',subscript:true},{text:'\n<&\tend'}];
  const text=runs.map(r=>r.text).join('');
  const bytes=Write.buildDocx([{type:'p',text,runs},{type:'table',header:['Target'],rows:[[{text,runs}]]},{type:'p',text:'actual',runs:[{text:'WRONG',bold:true}]}]);
  const xml=await Zip.extractText(bytes,'word/document.xml');
  for(const marker of ['<w:b/>','<w:i/>','<w:u w:val="single"/>','<w:vertAlign w:val="superscript"/>','<w:vertAlign w:val="subscript"/>','<w:br/>','<w:tab/>','&lt;&amp;'])assert.ok(xml.includes(marker),marker);
  assert.ok(xml.includes('actual'));assert.ok(!xml.includes('WRONG'));
  assert.ok(xml.slice(xml.indexOf('<w:tbl>')).includes('<w:i/>'));
  const tracked=await Zip.extractText(Write.buildDocx([{type:'trk',previous:{text:'old',runs:[{text:'old',bold:true}]},current:{text:'new',runs:[{text:'new',italic:true}]},author:'Editor'}]),'word/document.xml');
  assert.match(tracked,/<w:del[^>]*>.*<w:b\/>.*<w:delText[^>]*>old/);
  assert.match(tracked,/<w:ins[^>]*>.*<w:i\/>.*<w:t[^>]*>new/);
  console.log('13 DOCX formatting assertions passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
