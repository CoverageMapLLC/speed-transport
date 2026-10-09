import net from 'node:net';
import tls from 'node:tls';
import { TCP_PREAMBLE } from '../detect.js';
import {
  CloseCode,
  FrameParser,
  Opcode,
  encodeClosePayload,
  encodeFrame,
  encodeFrameHeader,
} from '../frame.js';

export interface SpeedTransportSocketOptions {
  /** Verify the server certificate for `tcps://`. Default true. */
  rejectUnauthorized?: boolean;
  /** Extra certificate authorities for `tcps://`. */
  ca?: string | Buffer | Array<string | Buffer>;
  /** TLS server name. Defaults to the URL host unless it is an IP address. */
  servername?: string;
  /** Fail if the server has not answered the preamble within this time. Default 10 s. */
  connectTimeoutMs?: number;
  /** Largest message accepted. Default 64 MiB. */
  maxMessageBytes?: number;
  /**
   * `copy` (default) delivers every payload like a WebSocket. `discard` never copies binary
   * messages larger than `bulkThresholdBytes`: they arrive as a zero-filled ArrayBuffer of
   * the right length that is shared between messages. For throughput tests that only count
   * bytes this removes all per-byte work on the client.
   */
  binaryPayloads?: 'copy' | 'discard';
  /** Size above which `discard` applies. Default 64 KiB. */
  bulkThresholdBytes?: number;
}

export type BinaryType = 'arraybuffer' | 'nodebuffer';

type Handler<E extends Event> = ((this: SpeedTransportSocket, event: E) => void) | null;

/** Close event with the fields of the WebSocket `CloseEvent`. */
export class SpeedTransportCloseEvent extends Event {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;

  constructor(code: number, reason: string, wasClean: boolean) {
    super('close');
    this.code = code;
    this.reason = reason;
    this.wasClean = wasClean;
  }
}

const PONG_EMPTY = encodeFrame(Opcode.Pong);
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const DEFAULT_BULK_THRESHOLD = 64 * 1024;
const CLOSE_TIMEOUT_MS = 1_000;

/** Parses `tcp://host:port` and `tcps://host:port`. */
export function parseTransportUrl(url: string): { secure: boolean; host: string; port: number } {
  const parsed = new URL(url);
  if (parsed.protocol !== 'tcp:' && parsed.protocol !== 'tcps:') {
    throw new SyntaxError(`Unsupported URL scheme ${parsed.protocol} (expected tcp: or tcps:)`);
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    throw new SyntaxError('A tcp:// or tcps:// URL needs an explicit port');
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  return { secure: parsed.protocol === 'tcps:', host, port };
}

/**
 * Raw TCP transport client with the browser WebSocket API, so code written for
 * `WebSocket` works unchanged with `tcp://` and `tcps://` URLs. Frames are never masked,
 * which removes the per-byte work a WebSocket client does on every send.
 */
export class SpeedTransportSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  binaryType: BinaryType = 'arraybuffer';
  readyState = SpeedTransportSocket.CONNECTING;

  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onerror: Handler<Event> = null;
  onclose: Handler<SpeedTransportCloseEvent> = null;

  private readonly socket: net.Socket;
  private readonly parser: FrameParser;
  private readonly discard: boolean;
  private readonly headerCache = new Map<number, Buffer>();
  private readonly bulkBuffers = new Map<number, ArrayBuffer>();
  private preamble: Buffer | null = Buffer.alloc(0);
  private connectTimer: NodeJS.Timeout | null = null;
  private closeTimer: NodeJS.Timeout | null = null;
  private closeSent = false;
  private closeCode: number = CloseCode.Abnormal;
  private closeReason = '';
  private closeReceived = false;

  constructor(url: string, options: SpeedTransportSocketOptions = {}) {
    super();
    this.url = url;
    const { secure, host, port } = parseTransportUrl(url);
    this.discard = options.binaryPayloads === 'discard';
    const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

    this.parser = new FrameParser(
      {
        requireMask: false,
        maxMessageBytes,
        maxBufferedMessageBytes: this.discard
          ? (options.bulkThresholdBytes ?? DEFAULT_BULK_THRESHOLD)
          : maxMessageBytes,
      },
      {
        onMessage: (data, binary) => this.deliver(binary ? this.toBinary(data) : data.toString('utf8')),
        onBulkMessage: (length, binary) => this.deliver(binary ? this.bulkPayload(length) : ''),
        onPing: (payload) => {
          if (this.readyState === SpeedTransportSocket.OPEN) {
            this.socket.write(payload.length === 0 ? PONG_EMPTY : encodeFrame(Opcode.Pong, payload));
          }
        },
        onPong: () => {},
        onClose: (code, reason) => this.onPeerClose(code, reason),
        onError: (code, reason) => this.failConnection(code, reason),
      }
    );

    const onConnect = () => {
      this.socket.setNoDelay(true);
      this.socket.write(TCP_PREAMBLE);
    };
    this.socket = secure
      ? tls.connect(
          {
            host,
            port,
            servername: options.servername ?? (net.isIP(host) ? undefined : host),
            rejectUnauthorized: options.rejectUnauthorized ?? true,
            ca: options.ca,
          },
          onConnect
        )
      : net.connect({ host, port }, onConnect);

    this.connectTimer = setTimeout(
      () => this.abort('Connection timed out'),
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    );
    this.connectTimer.unref?.();

    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', () => {
      if (this.readyState === SpeedTransportSocket.CONNECTING) this.dispatch(new Event('error'));
    });
    this.socket.on('end', () => this.socket.end());
    this.socket.once('close', () => this.onSocketClose());
  }

  /** Bytes queued in the socket and not yet handed to the kernel. */
  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState === SpeedTransportSocket.CONNECTING) {
      throw new DOMException('Still in CONNECTING state', 'InvalidStateError');
    }
    if (this.readyState !== SpeedTransportSocket.OPEN) return;

    if (typeof data === 'string') {
      this.socket.write(encodeFrame(Opcode.Text, Buffer.from(data, 'utf8')));
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const socket = this.socket;
    socket.cork();
    socket.write(this.header(bytes.byteLength));
    if (bytes.byteLength > 0) socket.write(bytes);
    socket.uncork();
  }

  close(code: number = CloseCode.Normal, reason = ''): void {
    if (this.readyState === SpeedTransportSocket.CLOSING || this.readyState === SpeedTransportSocket.CLOSED) return;
    if (this.readyState === SpeedTransportSocket.CONNECTING) {
      this.abort('Closed before the connection was established');
      return;
    }
    this.readyState = SpeedTransportSocket.CLOSING;
    this.sendClose(code, reason);
    this.armCloseTimer();
  }

  private header(length: number): Buffer {
    let header = this.headerCache.get(length);
    if (!header) {
      header = encodeFrameHeader(Opcode.Binary, length);
      if (this.headerCache.size < 16) this.headerCache.set(length, header);
    }
    return header;
  }

  private onData(chunk: Buffer): void {
    if (this.preamble) {
      const collected = Buffer.concat([this.preamble, chunk]);
      const needed = TCP_PREAMBLE.length;
      const compare = Math.min(collected.length, needed);
      if (!collected.subarray(0, compare).equals(TCP_PREAMBLE.subarray(0, compare))) {
        this.abort('Server does not speak the raw TCP transport');
        return;
      }
      if (collected.length < needed) {
        this.preamble = collected;
        return;
      }
      this.preamble = null;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.readyState = SpeedTransportSocket.OPEN;
      this.dispatch(new Event('open'));
      const rest = collected.subarray(needed);
      if (rest.length > 0 && this.readyState === SpeedTransportSocket.OPEN) this.parser.push(rest);
      return;
    }
    this.parser.push(chunk);
  }

  private toBinary(data: Buffer): ArrayBuffer | Buffer {
    if (this.binaryType === 'nodebuffer') return data;
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) return data.buffer as ArrayBuffer;
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  private bulkPayload(length: number): ArrayBuffer | Buffer {
    let buffer = this.bulkBuffers.get(length);
    if (!buffer) {
      buffer = new ArrayBuffer(length);
      if (this.bulkBuffers.size < 8) this.bulkBuffers.set(length, buffer);
    }
    return this.binaryType === 'nodebuffer' ? Buffer.from(buffer) : buffer;
  }

  private deliver(data: string | ArrayBuffer | Buffer): void {
    if (this.readyState !== SpeedTransportSocket.OPEN) return;
    this.dispatch(new MessageEvent('message', { data }));
  }

  private dispatch(event: Event): void {
    this.dispatchEvent(event);
    const handler = (this as unknown as Record<string, Handler<Event>>)[`on${event.type}`];
    handler?.call(this, event);
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    this.socket.write(encodeFrame(Opcode.Close, encodeClosePayload(code, reason)));
  }

  private armCloseTimer(): void {
    if (this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_TIMEOUT_MS);
    this.closeTimer.unref?.();
  }

  private onPeerClose(code: number | null, reason: string): void {
    this.closeReceived = true;
    this.closeCode = code ?? CloseCode.NoStatus;
    this.closeReason = reason;
    this.readyState = SpeedTransportSocket.CLOSING;
    this.sendClose(code ?? CloseCode.Normal, '');
    this.socket.end();
    this.armCloseTimer();
  }

  private failConnection(code: number, reason: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = SpeedTransportSocket.CLOSING;
    this.sendClose(code, reason);
    this.dispatch(new Event('error'));
    this.socket.end();
    this.armCloseTimer();
  }

  private abort(reason: string): void {
    if (this.readyState === SpeedTransportSocket.CLOSED) return;
    this.closeReason = reason;
    if (this.readyState === SpeedTransportSocket.CONNECTING) this.dispatch(new Event('error'));
    this.readyState = SpeedTransportSocket.CLOSING;
    this.socket.destroy();
  }

  private onSocketClose(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.connectTimer = null;
    this.closeTimer = null;
    const wasClean = this.closeReceived && this.closeSent;
    this.readyState = SpeedTransportSocket.CLOSED;
    this.dispatch(new SpeedTransportCloseEvent(this.closeCode, this.closeReason, wasClean));
  }
}

export interface ProbeOptions {
  /** Use TLS (`tcps://`). Default false. */
  secure?: boolean;
  timeoutMs?: number;
  rejectUnauthorized?: boolean;
  servername?: string;
}

/**
 * Resolves true when the server at `host:port` speaks the raw TCP transport. Old servers
 * that only speak (secure) WebSocket close the connection or stay silent, and resolve false.
 */
export function probeTcpTransport(host: string, port: number, options: ProbeOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const onConnect = () => socket.write(TCP_PREAMBLE);
    const socket = options.secure
      ? tls.connect(
          {
            host,
            port,
            servername: options.servername ?? (net.isIP(host) ? undefined : host),
            rejectUnauthorized: options.rejectUnauthorized ?? true,
          },
          onConnect
        )
      : net.connect({ host, port }, onConnect);
    const timer = setTimeout(() => finish(false), options.timeoutMs ?? 3000);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const compare = Math.min(received.length, TCP_PREAMBLE.length);
      if (!received.subarray(0, compare).equals(TCP_PREAMBLE.subarray(0, compare))) finish(false);
      else if (received.length >= TCP_PREAMBLE.length) finish(true);
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}
