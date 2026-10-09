import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import {
  CloseCode,
  FrameParser,
  Opcode,
  encodeClosePayload,
  encodeFrame,
  encodeFrameHeader,
} from './frame.js';
import { withDefaults } from './defaults.js';

export type TransportKind = 'tcp' | 'websocket';

export interface ConnectionLimits {
  /** Messages larger than this close the connection with 1009. */
  maxMessageBytes: number;
  /** Larger messages are counted, not assembled. See `bulk`. */
  maxBufferedMessageBytes: number;
  /** Connections that receive nothing for this long are destroyed. 0 disables it. */
  idleTimeoutMs: number;
  /** How long a close handshake may take before the socket is destroyed. */
  closeTimeoutMs: number;
  /** `sendMessages` pauses while more than this is queued in the socket. */
  sendHighWaterBytes: number;
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  maxMessageBytes: 16 * 1024 * 1024,
  maxBufferedMessageBytes: 64 * 1024,
  idleTimeoutMs: 60_000,
  closeTimeoutMs: 1_000,
  sendHighWaterBytes: 10 * 1024 * 1024,
};

export interface ConnectionEvents {
  /** A buffered message: text (valid UTF-8) or binary up to `maxBufferedMessageBytes`. */
  message: [data: Buffer, binary: boolean];
  /** A message larger than `maxBufferedMessageBytes`. Its payload was never copied. */
  bulk: [length: number, binary: boolean];
  ping: [payload: Buffer];
  pong: [payload: Buffer];
  /** The connection is gone. `code` is 1006 when it ended without a close handshake. */
  close: [code: number, reason: string];
}

export interface ConnectionOptions {
  kind: TransportKind;
  secure: boolean;
  /** The upgrade request, for WebSocket connections. */
  request?: IncomingMessage | null;
  limits?: Partial<ConnectionLimits>;
  /** Bytes already read from the socket after the handshake or preamble. */
  head?: Buffer;
}

type State = 'open' | 'closing' | 'closed';

const PONG_EMPTY = encodeFrame(Opcode.Pong);

/**
 * One client session over the raw TCP or WebSocket transport, plain or TLS. Both use the
 * same frames; only WebSocket requires client frames to be masked.
 */
export class Connection extends EventEmitter<ConnectionEvents> {
  readonly kind: TransportKind;
  readonly secure: boolean;
  readonly request: IncomingMessage | null;
  readonly remoteAddress: string | undefined;
  readonly limits: ConnectionLimits;

  private state: State = 'open';
  private closeSent = false;
  /** Code and reason reported by `close`: the peer's, or ours after a protocol error. */
  private closeCode: number | null = null;
  private closeReason = '';
  private closeTimer: NodeJS.Timeout | null = null;
  private readonly parser: FrameParser;
  private readonly headerCache = new Map<number, Buffer>();
  private head: Buffer | null;
  private started = false;

  constructor(
    readonly socket: Socket,
    options: ConnectionOptions
  ) {
    super();
    this.kind = options.kind;
    this.secure = options.secure;
    this.request = options.request ?? null;
    this.remoteAddress = socket.remoteAddress;
    this.limits = withDefaults(DEFAULT_CONNECTION_LIMITS, options.limits);
    this.head = options.head && options.head.length > 0 ? options.head : null;

    this.parser = new FrameParser(
      {
        requireMask: this.kind === 'websocket',
        maxMessageBytes: this.limits.maxMessageBytes,
        maxBufferedMessageBytes: this.limits.maxBufferedMessageBytes,
      },
      {
        onMessage: (data, binary) => {
          if (this.state === 'open') this.emit('message', data, binary);
        },
        onBulkMessage: (length, binary) => {
          if (this.state === 'open') this.emit('bulk', length, binary);
        },
        onPing: (payload) => {
          if (this.state !== 'open') return;
          this.socket.write(payload.length === 0 ? PONG_EMPTY : encodeFrame(Opcode.Pong, payload));
          this.emit('ping', payload);
        },
        onPong: (payload) => this.emit('pong', payload),
        onClose: (code, reason) => this.onPeerClose(code, reason),
        onError: (code, reason) => this.fail(code, reason),
      }
    );

    socket.setNoDelay(true);
    if (this.limits.idleTimeoutMs > 0) {
      socket.setTimeout(this.limits.idleTimeoutMs, () => socket.destroy());
    }
    socket.on('data', (chunk: Buffer) => this.parser.push(chunk));
    socket.on('error', () => {});
    socket.on('end', () => {
      if (this.state === 'open') socket.end();
    });
    socket.once('close', () => this.onSocketClose());
  }

  /**
   * Starts reading. Call once listeners are attached: bytes that arrived with the handshake
   * are parsed here, synchronously. The server calls it after `onConnection`.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const head = this.head;
    this.head = null;
    if (head) this.parser.push(head);
    this.socket.resume();
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  /** Bytes queued in the socket and not yet handed to the kernel. */
  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  sendText(text: string): boolean {
    if (this.state !== 'open') return false;
    return this.socket.write(encodeFrame(Opcode.Text, Buffer.from(text, 'utf8')));
  }

  sendBinary(data: Buffer | Uint8Array): boolean {
    if (this.state !== 'open') return false;
    const socket = this.socket;
    socket.cork();
    socket.write(this.header(data.length));
    const flushed = socket.write(data);
    socket.uncork();
    return flushed;
  }

  /** Writes an already encoded frame, for example a precomputed reply. */
  sendFrame(frame: Buffer): boolean {
    if (this.state !== 'open') return false;
    return this.socket.write(frame);
  }

  /**
   * Sends `payload` as `count` binary messages, pausing whenever more than
   * `sendHighWaterBytes` is queued. Resolves with the number of messages handed to the
   * socket once all are queued or the connection is no longer open.
   */
  sendMessages(payload: Buffer, count: number): Promise<number> {
    const header = this.header(payload.length);
    const socket = this.socket;
    const highWater = this.limits.sendHighWaterBytes;
    let sent = 0;

    return new Promise<number>((resolve) => {
      const finish = () => {
        socket.off('drain', pump);
        this.off('close', finish);
        resolve(sent);
      };
      const pump = () => {
        while (sent < count) {
          if (this.state !== 'open') {
            finish();
            return;
          }
          socket.cork();
          socket.write(header);
          socket.write(payload);
          socket.uncork();
          sent++;
          if (socket.writableLength >= highWater) {
            socket.once('drain', pump);
            return;
          }
        }
        finish();
      };
      this.once('close', finish);
      pump();
    });
  }

  ping(payload: Buffer = Buffer.alloc(0)): boolean {
    if (this.state !== 'open') return false;
    return this.socket.write(encodeFrame(Opcode.Ping, payload));
  }

  /** Starts the close handshake. The socket is destroyed if the peer does not answer. */
  close(code: number = CloseCode.Normal, reason = ''): void {
    if (this.state !== 'open') return;
    this.state = 'closing';
    this.sendClose(code, reason);
    this.armCloseTimer();
  }

  /**
   * Ends the connection at once with a TCP reset, dropping everything still queued for the
   * peer. A graceful close would deliver those bytes first, which keeps a slow link busy.
   */
  reset(): void {
    if (this.state === 'closed') return;
    this.state = 'closing';
    resetSocket(this.socket);
  }

  /** Destroys the socket without a close handshake. */
  terminate(): void {
    if (this.state === 'closed') return;
    this.state = 'closing';
    this.socket.destroy();
  }

  private header(length: number): Buffer {
    let header = this.headerCache.get(length);
    if (!header) {
      header = encodeFrameHeader(Opcode.Binary, length);
      if (this.headerCache.size < 16) this.headerCache.set(length, header);
    }
    return header;
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    this.socket.write(encodeFrame(Opcode.Close, encodeClosePayload(code, reason)));
  }

  private armCloseTimer(): void {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.socket.destroy(), this.limits.closeTimeoutMs);
    this.closeTimer.unref?.();
  }

  private onPeerClose(code: number | null, reason: string): void {
    this.closeCode = code ?? CloseCode.NoStatus;
    this.closeReason = reason;
    this.state = 'closing';
    // Echo the peer's code, as RFC 6455 section 5.5.1 asks.
    this.sendClose(code ?? CloseCode.Normal, '');
    this.socket.end();
    this.armCloseTimer();
  }

  private fail(code: number, reason: string): void {
    if (this.state === 'closed') return;
    this.closeCode = code;
    this.closeReason = reason;
    this.state = 'closing';
    this.sendClose(code, reason);
    this.socket.end();
    this.armCloseTimer();
  }

  private onSocketClose(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.state = 'closed';
    this.emit('close', this.closeCode ?? CloseCode.Abnormal, this.closeReason);
    this.removeAllListeners();
  }
}

/**
 * Resets the TCP connection under `socket`. TLS sockets only expose the reset on the TCP
 * socket they wrap. Anything that cannot be reset is destroyed normally.
 */
export function resetSocket(socket: Socket): void {
  const tcp = (socket as Socket & { _parent?: Socket | null })._parent ?? socket;
  try {
    tcp.resetAndDestroy();
  } catch {
    // Not a TCP socket
  }
  socket.destroy();
}
