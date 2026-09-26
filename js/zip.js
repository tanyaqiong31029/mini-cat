/* Mini-CAT zip.js — minimal ZIP archive reader (stored + deflate), zero dependencies.
 * Deflate uses the browser/Node built-in DecompressionStream('deflate-raw').
 * Enough for .xlsx / .docx containers: reads the central directory, inflates
 * requested entries by name. Not a general-purpose zip library. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.MiniCatZip = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const decoder = () => new TextDecoder('utf-8');

  function u16(view, off) { return view.getUint16(off, true); }
  function u32(view, off) { return view.getUint32(off, true); }

  /* Accept ArrayBuffer (browser f.arrayBuffer()) or Node Buffer/Uint8Array. */
  function toAB(buf) {
    if (buf instanceof ArrayBuffer) return buf;
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  /* Parse the central directory: returns Map<name, {method, compSize, offset}> */
  function readCentralDirectory(buf) {
    buf = toAB(buf);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    // locate End Of Central Directory (scan backwards; comment ≤ 65535)
    const minEOCD = 22;
    let eocd = -1;
    const start = Math.max(0, buf.byteLength - minEOCD - 65535);
    for (let i = buf.byteLength - minEOCD; i >= start; i--) {
      if (u32(view, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP: 未找到 EOCD（不是 zip 容器或已损坏）');
    const total = u16(view, eocd + 10);
    let ptr = u32(view, eocd + 16); // central directory offset
    const entries = new Map();
    for (let i = 0; i < total; i++) {
      if (u32(view, ptr) !== 0x02014b50) break;
      const method = u16(view, ptr + 10);
      const compSize = u32(view, ptr + 20);
      const nameLen = u16(view, ptr + 28);
      const extraLen = u16(view, ptr + 30);
      const commentLen = u16(view, ptr + 32);
      const localOff = u32(view, ptr + 42);
      const name = decoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      entries.set(name, { method, compSize, localOff });
      ptr += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  /* Extract one entry as Uint8Array. */
  async function extract(buf, name) {
    buf = toAB(buf);
    const entries = readCentralDirectory(buf);
    const entry = entries.get(name);
    if (!entry) throw new Error(`ZIP: 缺少条目 ${name}`);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const off = entry.localOff;
    if (u32(view, off) !== 0x04034b50) throw new Error(`ZIP: ${name} 本地头损坏`);
    const nameLen = u16(view, off + 26);
    const extraLen = u16(view, off + 28);
    const dataStart = off + 30 + nameLen + extraLen;
    const raw = bytes.subarray(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('当前浏览器不支持 DecompressionStream，无法读取 xlsx/docx（请用 Chrome/Edge 80+ 或 Safari 16.4+），或将文件另存为 CSV');
      }
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([raw]).stream().pipeThrough(ds);
      const out = await new Response(stream).arrayBuffer();
      return new Uint8Array(out);
    }
    throw new Error(`ZIP: 不支持的压缩方式 ${entry.method}（${name}）`);
  }

  async function extractText(buf, name) {
    const bytes = await extract(buf, name);
    return decoder().decode(bytes);
  }

  async function list(buf) {
    return [...readCentralDirectory(buf).keys()];
  }

  return { readCentralDirectory, extract, extractText, list };
});
