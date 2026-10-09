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

/** Zero-filled payloads, allocated once per size and shared by every connection. */
export class ZeroBufferPool {
  private readonly buffers = new Map<number, Buffer>();

  get(sizeKb: number): Buffer {
    let buffer = this.buffers.get(sizeKb);
    if (!buffer) {
      buffer = Buffer.alloc(sizeKb * 1024);
      this.buffers.set(sizeKb, buffer);
    }
    return buffer;
  }

  get size(): number {
    return this.buffers.size;
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
