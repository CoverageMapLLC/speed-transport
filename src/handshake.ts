import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** RFC 6455 GUID appended to the client key to compute `Sec-WebSocket-Accept`. */
export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const KEY_PATTERN = /^[+/0-9A-Za-z]{22}==$/;

export function computeAcceptKey(key: string): string {
  return createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
}

export type UpgradeValidation =
  | { ok: true; key: string }
  | { ok: false; status: number; reason: string; headers?: Record<string, string> };

function headerIncludesToken(value: string | undefined, token: string): boolean {
  if (!value) return false;
  return value
    .split(',')
    .some((part) => part.trim().toLowerCase() === token);
}

/** Checks an upgrade request against RFC 6455 section 4.2.1. */
export function validateUpgradeRequest(req: IncomingMessage): UpgradeValidation {
  if (req.method !== 'GET') {
    return { ok: false, status: 405, reason: 'WebSocket upgrades must use GET' };
  }
  if (!headerIncludesToken(req.headers.upgrade, 'websocket')) {
    return { ok: false, status: 400, reason: 'Missing Upgrade: websocket' };
  }
  if (!headerIncludesToken(req.headers.connection, 'upgrade')) {
    return { ok: false, status: 400, reason: 'Missing Connection: Upgrade' };
  }
  if (req.headers['sec-websocket-version'] !== '13') {
    return {
      ok: false,
      status: 426,
      reason: 'Unsupported WebSocket version',
      headers: { 'Sec-WebSocket-Version': '13' },
    };
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !KEY_PATTERN.test(key.trim())) {
    return { ok: false, status: 400, reason: 'Invalid Sec-WebSocket-Key' };
  }
  return { ok: true, key: key.trim() };
}

/**
 * The 101 response. No subprotocol or extension is ever selected: compression would cost
 * CPU and distort throughput measurements.
 */
export function buildUpgradeResponse(key: string): string {
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`
  );
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** A complete HTTP error response that closes the connection. */
export function buildHttpErrorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {}
): string {
  const body = message;
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}
