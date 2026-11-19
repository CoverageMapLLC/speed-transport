import type { Connection } from './connection.js';
import { CloseCode, Opcode, encodeFrame } from './frame.js';
import {
  createSpeedTransportServer,
  type ServerLimits,
  type SpeedTransportServer,
  type SpeedTransportServerOptions,
} from './server.js';
import { withDefaults } from './defaults.js';

/**
 * The CoverageMap speed test protocol, identical on every transport:
 *
 * | Client sends                     | Server answers                                  |
 * |----------------------------------|-------------------------------------------------|
 * | text `PING`                      | text `PONG`                                     |
 * | text `START <kb> <count>`        | `count` binary messages of `kb` KiB of zeros    |
 * | any message over 128 bytes       | text `ACK`                                      |
 * | text `CLOSE`                     | connection reset at once                        |
 * | anything else                    | ignored                                         |
 *
 * Malformed or oversized `START` commands close the connection with 1008.
 */

/** Messages larger than this are upload data and get an `ACK`; smaller ones are commands. */
export const COMMAND_MAX_BYTES = 128;

export interface SpeedTestLimits {
  /** Largest frame size a single START may request, in KiB. */
  maxFrameSizeKb: number;
  /** Largest frame count a single START may request. */
  maxFrameCount: number;
}

export const DEFAULT_SPEED_TEST_LIMITS: SpeedTestLimits = {
  maxFrameSizeKb: 10240,
  maxFrameCount: 1000,
};

export interface StartCommand {
  sizeKb: number;
  count: number;
}

const POSITIVE_INTEGER = /^[1-9]\d*$/;

/** Parses `START <kb> <count>`. Returns null when the command is malformed. */
export function parseStartCommand(message: string): StartCommand | null {
  const parts = message.split(' ');
  if (parts.length !== 3 || parts[0] !== 'START') return null;
  if (!POSITIVE_INTEGER.test(parts[1]) || !POSITIVE_INTEGER.test(parts[2])) return null;
  const sizeKb = Number(parts[1]);
  const count = Number(parts[2]);
  if (!Number.isSafeInteger(sizeKb) || !Number.isSafeInteger(count)) return null;
  return { sizeKb, count };
}

/**
 * Most bytes a `ZeroBufferPool` keeps alive. Clients use a fixed set of sizes (powers of two
 * up to 4 MiB plus 5 MiB, and a few estimation sizes), well under this together.
 */
export const MAX_POOLED_BYTES = 32 * 1024 * 1024;

/**
 * Zero-filled payloads, allocated once per size and shared by every connection. Pooling
 * stops once the pool would hold more than `MAX_POOLED_BYTES`, so arbitrary sizes cannot
 * keep more than that alive; other sizes get a fresh buffer per `START` that is not kept.
 */
export class ZeroBufferPool {
  private readonly buffers = new Map<number, Buffer>();
  private pooledBytes = 0;

  get(sizeKb: number): Buffer {
    let buffer = this.buffers.get(sizeKb);
    if (!buffer) {
      buffer = Buffer.alloc(sizeKb * 1024);
      if (this.pooledBytes + buffer.length <= MAX_POOLED_BYTES) {
        this.buffers.set(sizeKb, buffer);
        this.pooledBytes += buffer.length;
      }
    }
    return buffer;
  }

  /** Number of sizes kept. */
  get size(): number {
    return this.buffers.size;
  }

  /** Bytes the pool keeps alive, at most `MAX_POOLED_BYTES`. */
  get bytes(): number {
    return this.pooledBytes;
  }
}

export interface SpeedTestProtocolOptions {
  limits?: Partial<SpeedTestLimits>;
  pool?: ZeroBufferPool;
  /** Reports protocol activity, for metrics. */
  onEvent?: (event: SpeedTestEvent) => void;
}

export type SpeedTestEvent =
  | { type: 'start'; connection: Connection; command: StartCommand }
  | { type: 'upload'; connection: Connection; bytes: number }
  | { type: 'rejected'; connection: Connection; reason: string };

const ACK = encodeFrame(Opcode.Text, Buffer.from('ACK'));
const PONG = encodeFrame(Opcode.Text, Buffer.from('PONG'));

/** Returns an `onConnection` handler that speaks the speed test protocol. */
export function createSpeedTestProtocol(options: SpeedTestProtocolOptions = {}): (connection: Connection) => void {
  const limits = withDefaults(DEFAULT_SPEED_TEST_LIMITS, options.limits);
  const pool = options.pool ?? new ZeroBufferPool();
  const onEvent = options.onEvent;

  const reject = (connection: Connection, reason: string) => {
    onEvent?.({ type: 'rejected', connection, reason });
    connection.close(CloseCode.PolicyViolation, reason);
  };

  return (connection) => {
    connection.on('bulk', (length) => {
      connection.sendFrame(ACK);
      onEvent?.({ type: 'upload', connection, bytes: length });
    });

    connection.on('message', (data, binary) => {
      if (data.length > COMMAND_MAX_BYTES) {
        connection.sendFrame(ACK);
        onEvent?.({ type: 'upload', connection, bytes: data.length });
        return;
      }
      if (binary) return;
      const message = data.toString('latin1');
      if (message === 'PING') {
        connection.sendFrame(PONG);
      } else if (message === 'CLOSE') {
        connection.reset();
      } else if (message.startsWith('START')) {
        const command = parseStartCommand(message);
        if (!command) {
          reject(connection, 'Malformed START command');
        } else if (command.sizeKb > limits.maxFrameSizeKb) {
          reject(connection, 'Frame size limit exceeded');
        } else if (command.count > limits.maxFrameCount) {
          reject(connection, 'Frame count limit exceeded');
        } else {
          onEvent?.({ type: 'start', connection, command });
          void connection.sendMessages(pool.get(command.sizeKb), command.count);
        }
      }
    });
  };
}

export interface SpeedTestServerOptions extends Omit<SpeedTransportServerOptions, 'onConnection'> {
  speedTest?: SpeedTestProtocolOptions;
}

/**
 * A server that speaks the speed test protocol on every transport. Messages up to
 * `COMMAND_MAX_BYTES` are buffered as commands; larger ones are counted as upload data.
 */
export function createSpeedTestServer(options: SpeedTestServerOptions): SpeedTransportServer {
  const { speedTest, limits, ...rest } = options;
  return createSpeedTransportServer({
    ...rest,
    limits: withDefaults<Partial<ServerLimits>>({ maxBufferedMessageBytes: COMMAND_MAX_BYTES }, limits),
    onConnection: createSpeedTestProtocol(speedTest),
  });
}
