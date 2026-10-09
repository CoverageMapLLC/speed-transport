import { isUtf8 } from 'node:buffer';

/**
 * Frame encoding and a streaming frame parser.
 *
 * Every transport uses the RFC 6455 WebSocket frame layout. WebSocket clients must mask
 * their frames; raw TCP clients send the same frames unmasked. The parser buffers small
 * messages (commands) and only counts the payload of large ones, so bulk upload data is
 * never copied, unmasked, or allocated.
 */

export const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;

export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode];

/** WebSocket close codes used by the library. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  ProtocolError: 1002,
  UnsupportedData: 1003,
  NoStatus: 1005,
  Abnormal: 1006,
  InvalidPayload: 1007,
  PolicyViolation: 1008,
  MessageTooBig: 1009,
  InternalError: 1011,
} as const;

const MAX_CONTROL_PAYLOAD = 125;
const MAX_SAFE_LENGTH = Number.MAX_SAFE_INTEGER;

/** Encodes the header of an unmasked frame. */
export function encodeFrameHeader(opcode: number, payloadLength: number, fin = true): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  if (payloadLength < 126) {
    return Buffer.from([first, payloadLength]);
  }
  if (payloadLength < 65536) {
    const header = Buffer.allocUnsafe(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
    return header;
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = first;
  header[1] = 127;
  header.writeUInt32BE(Math.floor(payloadLength / 0x100000000), 2);
  header.writeUInt32BE(payloadLength >>> 0, 6);
  return header;
}

/** Encodes a complete unmasked frame. Intended for small payloads. */
export function encodeFrame(opcode: number, payload: Buffer | Uint8Array = EMPTY, fin = true): Buffer {
  const header = encodeFrameHeader(opcode, payload.length, fin);
  if (payload.length === 0) return header;
  return Buffer.concat([header, payload]);
}

/** Encodes a masked frame, as a WebSocket client must send it. */
export function encodeMaskedFrame(
  opcode: number,
  payload: Buffer | Uint8Array = EMPTY,
  mask: Uint8Array = DEFAULT_MASK,
  fin = true
): Buffer {
  const header = encodeFrameHeader(opcode, payload.length, fin);
  header[1] |= 0x80;
  const frame = Buffer.allocUnsafe(header.length + 4 + payload.length);
  header.copy(frame, 0);
  frame.set(mask.subarray(0, 4), header.length);
  const offset = header.length + 4;
  for (let i = 0; i < payload.length; i++) frame[offset + i] = payload[i] ^ mask[i & 3];
  return frame;
}

/** Encodes a close frame payload: a two byte code and an optional UTF-8 reason. */
export function encodeClosePayload(code: number, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, MAX_CONTROL_PAYLOAD - 2);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

/**
 * True for close codes a peer may send: the registered codes 1000-1003 and 1007-1014, and
 * the application ranges 3000-4999. 1004, 1005, 1006, and 1015 are reserved.
 */
export function isValidCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

const EMPTY = Buffer.alloc(0);
const DEFAULT_MASK = new Uint8Array([0x37, 0xfa, 0x21, 0x3d]);

export interface FrameParserOptions {
  /** Require the mask bit on every frame (WebSocket from a client). */
  requireMask: boolean;
  /** Messages larger than this close the connection with 1009. */
  maxMessageBytes: number;
  /**
   * Messages up to this size are assembled, unmasked, validated, and delivered through
   * `onMessage`. Larger messages are only counted and reported through `onBulkMessage`.
   */
  maxBufferedMessageBytes: number;
}

export interface FrameParserHandler {
  /** A buffered message. Text messages are valid UTF-8. */
  onMessage(data: Buffer, binary: boolean): void;
  /** A message larger than `maxBufferedMessageBytes`; its payload was skipped. */
  onBulkMessage(length: number, binary: boolean): void;
  onPing(payload: Buffer): void;
  onPong(payload: Buffer): void;
  /** The peer sent a close frame. `code` is null when the frame carried no code. */
  onClose(code: number | null, reason: string): void;
  /** The input violated the protocol; the parser stops. */
  onError(code: number, reason: string): void;
}

const enum State {
  Header,
  Payload,
  Failed,
}

/**
 * Incremental frame parser. Feed it every chunk read from the socket with `push`; chunk
 * boundaries can fall anywhere, including inside a header or a mask.
 */
export class FrameParser {
  private state = State.Header;
  private readonly header = Buffer.allocUnsafe(14);
  private headerLength = 0;
  private headerNeeded = 2;

  // Current frame
  private opcode = 0;
  private fin = false;
  private masked = false;
  private readonly mask = Buffer.allocUnsafe(4);
  private remaining = 0;
  private frameOffset = 0;
  private control = false;
  private controlPayload: Buffer = EMPTY;

  // Current message (data frames)
  private messageOpcode = 0;
  private messageLength = 0;
  private inMessage = false;
  private buffering = false;
  private chunks: Buffer[] = [];

  constructor(
    private readonly options: FrameParserOptions,
    private readonly handler: FrameParserHandler
  ) {}

  /** True once a protocol error was reported; further input is ignored. */
  get failed(): boolean {
    return this.state === State.Failed;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    const length = chunk.length;
    while (offset < length && this.state !== State.Failed) {
      if (this.state === State.Payload) {
        const take = Math.min(this.remaining, length - offset);
        if (this.control || this.buffering) this.copyPayload(chunk, offset, take);
        offset += take;
        this.remaining -= take;
        this.frameOffset += take;
        if (this.remaining === 0) this.finishFrame();
        continue;
      }

      // Header: take the fast path when the whole header is inside this chunk.
      if (this.headerLength === 0 && length - offset >= 2) {
        const second = chunk[offset + 1];
        const lengthCode = second & 0x7f;
        const needed = 2 + (lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0) + (second & 0x80 ? 4 : 0);
        if (length - offset >= needed) {
          this.startFrame(chunk, offset);
          offset += needed;
          continue;
        }
      }

      this.header[this.headerLength++] = chunk[offset++];
      if (this.headerLength === 2) {
        const lengthCode = this.header[1] & 0x7f;
        this.headerNeeded =
          2 + (lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0) + (this.header[1] & 0x80 ? 4 : 0);
      }
      if (this.headerLength >= 2 && this.headerLength === this.headerNeeded) {
        this.startFrame(this.header, 0);
        this.headerLength = 0;
        this.headerNeeded = 2;
      }
    }
  }

  private fail(code: number, reason: string): void {
    if (this.state === State.Failed) return;
    this.state = State.Failed;
    this.chunks = [];
    this.handler.onError(code, reason);
  }

  private startFrame(source: Buffer, at: number): void {
    const first = source[at];
    const second = source[at + 1];
    if (first & 0x70) {
      this.fail(CloseCode.ProtocolError, 'Reserved bits must be zero');
      return;
    }
    const opcode = first & 0x0f;
    const fin = (first & 0x80) !== 0;
    const masked = (second & 0x80) !== 0;
    if (this.options.requireMask && !masked) {
      this.fail(CloseCode.ProtocolError, 'Client frames must be masked');
      return;
    }

    const lengthCode = second & 0x7f;
    let payloadLength = lengthCode;
    let cursor = at + 2;
    if (lengthCode === 126) {
      payloadLength = source.readUInt16BE(cursor);
      cursor += 2;
    } else if (lengthCode === 127) {
      const high = source.readUInt32BE(cursor);
      const low = source.readUInt32BE(cursor + 4);
      if (high & 0x80000000) {
        this.fail(CloseCode.ProtocolError, 'Payload length must not set the most significant bit');
        return;
      }
      payloadLength = high * 0x100000000 + low;
      if (payloadLength > MAX_SAFE_LENGTH) {
        this.fail(CloseCode.MessageTooBig, 'Message too big');
        return;
      }
      cursor += 8;
    }
    if (masked) {
      this.mask[0] = source[cursor];
      this.mask[1] = source[cursor + 1];
      this.mask[2] = source[cursor + 2];
      this.mask[3] = source[cursor + 3];
    }

    const control = opcode >= 0x8;
    if (control) {
      if (opcode > Opcode.Pong) {
        this.fail(CloseCode.ProtocolError, `Unknown opcode ${opcode}`);
        return;
      }
      if (!fin) {
        this.fail(CloseCode.ProtocolError, 'Control frames must not be fragmented');
        return;
      }
      if (payloadLength > MAX_CONTROL_PAYLOAD) {
        this.fail(CloseCode.ProtocolError, 'Control frame payload too long');
        return;
      }
    } else if (opcode === Opcode.Continuation) {
      if (!this.inMessage) {
        this.fail(CloseCode.ProtocolError, 'Continuation frame without a message to continue');
        return;
      }
    } else if (opcode === Opcode.Text || opcode === Opcode.Binary) {
      if (this.inMessage) {
        this.fail(CloseCode.ProtocolError, 'New message before the previous one finished');
        return;
      }
    } else {
      this.fail(CloseCode.ProtocolError, `Unknown opcode ${opcode}`);
      return;
    }

    this.opcode = opcode;
    this.fin = fin;
    this.masked = masked;
    this.control = control;
    this.remaining = payloadLength;
    this.frameOffset = 0;

    if (control) {
      this.controlPayload = payloadLength === 0 ? EMPTY : Buffer.allocUnsafe(payloadLength);
    } else {
      if (opcode !== Opcode.Continuation) {
        this.inMessage = true;
        this.messageOpcode = opcode;
        this.messageLength = 0;
        this.buffering = true;
        this.chunks = [];
      }
      this.messageLength += payloadLength;
      if (this.messageLength > this.options.maxMessageBytes) {
        this.fail(CloseCode.MessageTooBig, 'Message too big');
        return;
      }
      if (this.buffering && this.messageLength > this.options.maxBufferedMessageBytes) {
        // Too large to assemble: count it from here on and drop what was collected.
        this.buffering = false;
        this.chunks = [];
      }
    }

    this.state = State.Payload;
    if (payloadLength === 0) this.finishFrame();
  }

  private copyPayload(source: Buffer, offset: number, length: number): void {
    let target: Buffer;
    let targetOffset: number;
    if (this.control) {
      target = this.controlPayload;
      targetOffset = this.frameOffset;
    } else {
      target = Buffer.allocUnsafe(length);
      targetOffset = 0;
      this.chunks.push(target);
    }
    if (this.masked) {
      const mask = this.mask;
      let maskIndex = this.frameOffset & 3;
      for (let i = 0; i < length; i++) {
        target[targetOffset + i] = source[offset + i] ^ mask[maskIndex];
        maskIndex = (maskIndex + 1) & 3;
      }
    } else {
      source.copy(target, targetOffset, offset, offset + length);
    }
  }

  private finishFrame(): void {
    this.state = State.Header;
    if (this.control) {
      this.control = false;
      const payload = this.controlPayload;
      this.controlPayload = EMPTY;
      if (this.opcode === Opcode.Ping) {
        this.handler.onPing(payload);
      } else if (this.opcode === Opcode.Pong) {
        this.handler.onPong(payload);
      } else {
        this.finishClose(payload);
      }
      return;
    }

    if (!this.fin) return;
    const binary = this.messageOpcode === Opcode.Binary;
    const messageLength = this.messageLength;
    this.inMessage = false;
    if (!this.buffering) {
      this.handler.onBulkMessage(messageLength, binary);
      return;
    }
    const chunks = this.chunks;
    this.chunks = [];
    const data = chunks.length === 1 ? chunks[0] : chunks.length === 0 ? EMPTY : Buffer.concat(chunks, messageLength);
    if (!binary && !isUtf8(data)) {
      this.fail(CloseCode.InvalidPayload, 'Text message is not valid UTF-8');
      return;
    }
    this.handler.onMessage(data, binary);
  }

  private finishClose(payload: Buffer): void {
    if (payload.length === 0) {
      this.handler.onClose(null, '');
      return;
    }
    if (payload.length === 1) {
      this.fail(CloseCode.ProtocolError, 'Close frame payload must be empty or at least two bytes');
      return;
    }
    const code = payload.readUInt16BE(0);
    if (!isValidCloseCode(code)) {
      this.fail(CloseCode.ProtocolError, `Invalid close code ${code}`);
      return;
    }
    const reasonBytes = payload.subarray(2);
    if (!isUtf8(reasonBytes)) {
      this.fail(CloseCode.InvalidPayload, 'Close reason is not valid UTF-8');
      return;
    }
    this.handler.onClose(code, reasonBytes.toString('utf8'));
  }
}
