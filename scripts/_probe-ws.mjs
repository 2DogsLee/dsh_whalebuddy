// 原始 TCP 客户端：发一个 WS 升级请求，看服务器返回什么
import { Socket } from 'node:net'
import { TLSSocket } from 'node:tls'

const port = Number(process.env.PORT || (process.env.DSH_WEB_URL?.match(/:(\d+)/)?.[1]) || '64171')
const host = '127.0.0.1'

const req =
  'GET /dsh-pet/ws HTTP/1.1\r\n' +
  'Host: 127.0.0.1:' + port + '\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
  'Sec-WebSocket-Version: 13\r\n' +
  '\r\n'

const sock = new Socket()
sock.setTimeout(5000)
let buf = Buffer.alloc(0)

sock.connect(port, host, () => {
  console.log('[client] connected, sending upgrade request')
  console.log('[request]\n' + req.replace(/\r\n/g, '\\r\\n\n'))
  sock.write(req)
})

sock.on('data', (c) => {
  buf = Buffer.concat([buf, c])
  // Check if we have full response headers
  const headerEnd = buf.indexOf('\r\n\r\n')
  if (headerEnd !== -1) {
    const headerText = buf.subarray(0, headerEnd + 4).toString('utf8')
    console.log('[response headers]\n' + headerText)
    const after = buf.subarray(headerEnd + 4)
    console.log('[after handshake bytes]', after.length, 'bytes')
    if (after.length > 0) {
      console.log('  hex:', after.toString('hex'))
      console.log('  ascii:', JSON.stringify(after.toString('utf8').replace(/[\x00-\x1f]/g, '.')))
    }
    sock.destroy()
    process.exit(0)
  }
})

sock.on('error', (e) => { console.log('[client error]', e.message); process.exit(1) })
sock.on('timeout', () => { console.log('[client timeout]'); sock.destroy(); process.exit(2) })
sock.on('close', (hadError) => {
  if (!hadError && buf.length === 0) console.log('[client close] no data received')
})