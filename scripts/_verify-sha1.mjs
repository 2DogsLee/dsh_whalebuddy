// 临时验证：用与插件中完全相同的 SHA-1 实现计算 RFC 6455 标准测试向量
// 期望：wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const enc = new TextEncoder()

function sha1Words(bytes) {
  // 标准 FIPS 180-4 参考实现的纯 JS 版版（Uint32Array 保证无符号语义）
  const ml = bytes.length
  const total = (((ml + 8) >>> 6) + 1) << 6
  const m = new Uint8Array(total)
  m.set(bytes)
  m[ml] = 0x80
  // 64-bit big-endian 长度在最后 8 字节
  const bitLen = ml * 8
  m[total - 1] = bitLen & 0xFF
  m[total - 2] = (bitLen >>> 8) & 0xFF
  m[total - 3] = (bitLen >>> 16) & 0xFF
  m[total - 4] = (bitLen >>> 24) & 0xFF
  // m[total-5..total-8] 对短消息保持 0

  let H0 = 0x67452301 | 0, H1 = 0xEFCDAB89 | 0, H2 = 0x98BADCFE | 0, H3 = 0x10325476 | 0, H4 = 0xC3D2E1F0 | 0
  const w = new Uint32Array(80)

  for (let chunk = 0; chunk < total; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((m[chunk + i * 4] << 24) | (m[chunk + i * 4 + 1] << 16) | (m[chunk + i * 4 + 2] << 8) | m[chunk + i * 4 + 3]) >>> 0
    }
    for (let i = 16; i < 80; i++) {
      const n = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 0
      w[i] = ((n << 1) | (n >>> 31)) >>> 0
    }

    let a = H0, b = H1, c = H2, d = H3, e = H4
    for (let i = 0; i < 80; i++) {
      let f, k
      if (i < 20) { f = ((b & c) | ((~b) & d)) >>> 0; k = 0x5A827999 }
      else if (i < 40) { f = (b ^ c ^ d) >>> 0; k = 0x6ED9EBA1 }
      else if (i < 60) { f = ((b & c) | (b & d) | (c & d)) >>> 0; k = 0x8F1BBCDC }
      else { f = (b ^ c ^ d) >>> 0; k = 0xCA62C1D6 }
      const temp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = temp
    }
    H0 = (H0 + a) >>> 0
    H1 = (H1 + b) >>> 0
    H2 = (H2 + c) >>> 0
    H3 = (H3 + d) >>> 0
    H4 = (H4 + e) >>> 0
  }
  return [H0, H1, H2, H3, H4]
}

function wsAcceptKey(key) {
  const input = enc.encode(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
  const words = sha1Words(input)
  const digest = new Uint8Array(20)
  for (let wi = 0; wi < 5; wi++) {
    const w = words[wi]
    digest[wi * 4] = (w >>> 24) & 255
    digest[wi * 4 + 1] = (w >>> 16) & 255
    digest[wi * 4 + 2] = (w >>> 8) & 255
    digest[wi * 4 + 3] = w & 255
  }
  return b64encode(digest)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function b64encode(bytes) {
  const len = bytes.length
  let out = ''
  let i = 0
  for (; i + 2 < len; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2]
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + B64[((b1 & 15) << 2) | (b2 >> 6)] + B64[b2 & 63]
  }
  const rem = len - i
  if (rem === 1) {
    const b0 = bytes[i]
    out += B64[b0 >> 2] + B64[(b0 & 3) << 4] + '=='
  } else if (rem === 2) {
    const b0 = bytes[i], b1 = bytes[i + 1]
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)] + B64[(b1 & 15) << 2] + '='
  }
  return out
}

// RFC 6455 §1.3 标准测试向量
const tests = [
  { key: 'dGhlIHNhbXBsZSBub25jZQ==', expected: 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' },
]

let ok = true
for (const t of tests) {
  const got = wsAcceptKey(t.key)
  const pass = got === t.expected
  if (!pass) ok = false
  console.log(`${pass ? '✓' : '✗'} key=${t.key}\n   got=${got}\n   exp=${t.expected}`)
}

// 额外：空字符串、SHA-1("")=da39a3ee5e6b4b0d3255bfef95601890afd80709
function b64OfWords(words) {
  const out = new Uint8Array(20)
  for (let i = 0; i < 5; i++) {
    const w = words[i]
    out[i*4] = (w >>> 24) & 255
    out[i*4+1] = (w >>> 16) & 255
    out[i*4+2] = (w >>> 8) & 255
    out[i*4+3] = w & 255
  }
  return b64encode(out)
}
const emptyB64 = b64OfWords(sha1Words(new Uint8Array(0)))
console.log(`${emptyB64 === '2jmj7l5rSw0yVb/vlWAYkK/YBwk=' ? '✓' : '✗'} SHA-1("") got ${emptyB64} expected 2jmj7l5rSw0yVb/vlWAYkK/YBwk=`)

// 额外："abc" → a9993e364706816aba3e25717850c26c9cd0d89d
const abcB64 = b64OfWords(sha1Words(enc.encode('abc')))
console.log(`${abcB64 === 'a9993e364706816aba3e25717850c26c9cd0d89d' ? '✓' : '✗'} SHA-1("abc") got ${abcB64} expected a9993e364706816aba3e25717850c26c9cd0d89d`)

// 额外：长输入（多块）"The quick brown fox jumps over the lazy dog" → 2fd4e1c67a2d28fced849ee1bb76e7391b93eb12
const longB64 = b64OfWords(sha1Words(enc.encode('The quick brown fox jumps over the lazy dog')))
console.log(`${longB64 === '2fd4e1c67a2d28fced849ee1bb76e7391b93eb12' ? '✓' : '✗'} SHA-1(long) got ${longB64} expected 2fd4e1c67a2d28fced849ee1bb76e7391b93eb12`)

process.exit(ok ? 0 : 1)