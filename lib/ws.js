/**
 * Minimal dependency-free RFC 6455 WebSocket server.
 *
 * `ws` happens to resolve inside the profile's node_modules today, but that is
 * a hoisting accident: a bundle must not depend on it. This module implements
 * exactly the server side of RFC 6455 that the extension bridge needs —
 * handshake, text/binary framing, fragmentation, ping/pong and close — with
 * `permessage-deflate` deliberately unsupported so no zlib negotiation can
 * silently change the byte stream.
 *
 * @module dsh-chrome-use/lib/ws
 */

import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Largest single frame this server accepts, in bytes. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024
/** Largest reassembled message (all fragments) this server accepts. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

/** Encode one server-to-client frame (never masked, per RFC 6455 §5.1). */
function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/**
 * One accepted WebSocket connection.
 * @fires WebSocketConnection#message
 * @fires WebSocketConnection#close
 */
export class WebSocketConnection extends EventEmitter {
  #socket
  #buffer = Buffer.alloc(0)
  #fragments = []
  #fragmentBytes = 0
  #closed = false
  #closeCode = 1006
  #closeReason = ''

  constructor(socket, request) {
    super()
    this.#socket = socket
    this.request = request
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('error', (error) => this.#finish(1006, error.message))
    socket.on('close', () => this.#finish(1006, 'socket closed'))
    socket.on('end', () => this.#finish(1006, 'socket ended'))
  }

  /** Stable identity for logs and the connection registry. */
  get id() {
    return this.request.__bridgeConnectionId ??= randomBytes(8).toString('hex')
  }

  /** True while the underlying socket accepts writes. */
  get open() {
    return !this.#closed && this.#socket.writable
  }

  /** Remote address recorded at handshake time. */
  get remoteAddress() {
    return this.#socket.remoteAddress ?? ''
  }

  /** Send one JSON-serializable message as a text frame. */
  sendJSON(value) {
    if (!this.open) return false
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    try {
      this.#socket.write(encodeFrame(OP_TEXT, payload))
      return true
    } catch (error) {
      this.#finish(1006, error instanceof Error ? error.message : 'write failed')
      return false
    }
  }

  /** Send one raw text frame. */
  sendText(text) {
    if (!this.open) return false
    try {
      this.#socket.write(encodeFrame(OP_TEXT, Buffer.from(String(text), 'utf8')))
      return true
    } catch {
      this.#finish(1006, 'write failed')
      return false
    }
  }

  /** Send one binary frame. */
  sendBinary(bytes) {
    if (!this.open) return false
    try {
      this.#socket.write(encodeFrame(OP_BINARY, Buffer.from(bytes)))
      return true
    } catch {
      this.#finish(1006, 'write failed')
      return false
    }
  }

  /** Best-effort protocol ping; the extension answers with a pong frame. */
  ping() {
    if (!this.open) return
    try {
      this.#socket.write(encodeFrame(OP_PING, Buffer.alloc(0)))
    } catch {
      this.#finish(1006, 'write failed')
    }
  }

  /**
   * Close the connection with a protocol close frame.
   * @param code RFC 6455 status code.
   * @param reason Short human-readable reason.
   */
  close(code = 1000, reason = '') {
    if (this.#closed) return
    const reasonBytes = Buffer.from(reason.slice(0, 120), 'utf8')
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    try {
      this.#socket.write(encodeFrame(OP_CLOSE, payload))
    } catch {
      // A failed close frame still ends the socket below.
    }
    this.#finish(code, reason)
    this.#socket.end()
  }

  /** Terminate without a close handshake. */
  destroy() {
    this.#finish(1006, 'destroyed')
    this.#socket.destroy()
  }

  #finish(code, reason) {
    if (this.#closed) return
    this.#closed = true
    this.#closeCode = code
    this.#closeReason = reason
    this.emit('close', { code, reason })
    this.removeAllListeners('message')
  }

  #onData(chunk) {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    while (this.#readFrame()) {
      // Drain every complete frame already buffered.
    }
  }

  /**
   * Parse and dispatch one buffered frame.
   * @returns whether one complete frame was consumed.
   */
  #readFrame() {
    const buffer = this.#buffer
    if (buffer.length < 2) return false
    const first = buffer[0]
    const second = buffer[1]
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return false
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return false
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_FRAME_BYTES)) {
        this.close(1009, 'frame too large')
        return false
      }
      length = Number(big)
      offset += 8
    }
    if (length > MAX_FRAME_BYTES) {
      this.close(1009, 'frame too large')
      return false
    }
    let maskKey
    if (masked) {
      if (buffer.length < offset + 4) return false
      maskKey = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return false
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (maskKey !== undefined) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index & 3]
    }
    this.#buffer = buffer.subarray(offset + length)

    if (opcode === OP_CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
      this.close(code === 1005 ? 1000 : code, reason)
      return false
    }
    if (opcode === OP_PING) {
      if (this.open) this.#socket.write(encodeFrame(OP_PONG, payload))
      return true
    }
    if (opcode === OP_PONG) {
      this.emit('pong')
      return true
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      this.#fragments = [payload]
      this.#fragmentBytes = payload.length
    } else if (opcode === OP_CONTINUATION) {
      this.#fragments.push(payload)
      this.#fragmentBytes += payload.length
    } else {
      this.close(1002, 'unsupported opcode')
      return false
    }
    if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
      this.close(1009, 'message too large')
      return false
    }
    if (!fin) return true
    const message = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments)
    this.#fragments = []
    this.#fragmentBytes = 0
    this.emit('message', message)
    return true
  }
}

/**
 * Router for `webServer.registerUpgrade` handlers.
 *
 * The route handler owns protocol negotiation: it validates the request, writes
 * the 101 response and hands the upgraded socket to a {@link WebSocketConnection}.
 */
export class WebSocketRouter extends EventEmitter {
  /** @param handshake Authorizes and annotates one upgrade request. */
  constructor(handshake) {
    super()
    this.handshake = handshake
    /** @type {Set<WebSocketConnection>} */
    this.connections = new Set()
  }

  /**
   * `registerUpgrade`-compatible handler.
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:stream').Duplex} socket
   */
  handleUpgrade(request, socket) {
    const reject = (status, message) => {
      const body = Buffer.from(message, 'utf8')
      socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${message}`,
      )
    }
    if (request.method !== 'GET') return reject('405 Method Not Allowed', 'upgrade requires GET')
    const upgrade = String(request.headers.upgrade ?? '').toLowerCase()
    if (upgrade !== 'websocket') return reject('400 Bad Request', 'expected websocket upgrade')
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string' || key.length === 0) return reject('400 Bad Request', 'missing sec-websocket-key')

    let admission
    try {
      admission = this.handshake(request)
    } catch (error) {
      return reject('500 Internal Server Error', error instanceof Error ? error.message : 'handshake failed')
    }
    if (!admission || admission.rejection !== undefined) {
      return reject('401 Unauthorized', admission?.rejection ?? 'unauthorized')
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'),
    )
    const connection = new WebSocketConnection(socket, request)
    connection.context = admission.context
    this.connections.add(connection)
    connection.on('close', () => this.connections.delete(connection))
    this.emit('connection', connection)
  }

  /** Close every live connection, then drop them from the registry. */
  closeAll(code = 1001, reason = 'server shutting down') {
    for (const connection of [...this.connections]) {
      try {
        connection.close(code, reason)
      } catch {
        connection.destroy()
      }
      this.connections.delete(connection)
    }
  }
}
