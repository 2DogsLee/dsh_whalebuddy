const fs = require('fs');
const zlib = require('zlib');
const path = process.argv[2];
if (!path) { console.error('用法: node _inspect-session.cjs <session.jsonl.zstd>'); process.exit(1); }
const buf = fs.readFileSync(path);
const decoded = zlib.zstdDecompressSync(buf);
console.log('解压字节数:', decoded.length);
const text = decoded.toString('utf8');
const lines = text.split('\n').filter(Boolean);
console.log('总行数:', lines.length);
console.log('--- session/title 事件 ---');
let titles = 0;
for (const line of lines) {
  try {
    const j = JSON.parse(line);
    if (j.type === 'session/title') {
      titles++;
      console.log('  [' + j.seq + '] title="' + j.data.title + '" source=' + j.data.source.kind);
    }
  } catch {}
}
if (titles === 0) console.log('  (无 session/title 事件)');
console.log('--- user/message 事件 ---');
let ums = [];
for (const line of lines) {
  try {
    const j = JSON.parse(line);
    if (j.type === 'user/message') {
      try { ums.push({ seq: j.seq, text: (j.data.content[0].text || '').slice(0, 100) }); } catch {}
    }
  } catch {}
}
console.log('总数:', ums.length);
if (ums.length > 0) {
  console.log('首条:', JSON.stringify(ums[0]));
  console.log('末条:', JSON.stringify(ums[ums.length - 1]));
}