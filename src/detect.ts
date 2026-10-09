/**
 * Protocol detection from the first bytes of a connection.
 *
 * - `0x16` starts every TLS handshake record, so the connection is TLS.
 * - The raw TCP transport starts with the preamble `STCP/1\n`.
 * - Anything starting with an uppercase ASCII letter is handed to the HTTP parser, which
 *   serves routes and WebSocket upgrades and rejects anything malformed.
 * - Everything else is closed.
 */

/** Preamble a raw TCP client sends first and the server echoes back. */
export const TCP_PREAMBLE = Buffer.from('STCP/1\n', 'latin1');

export type DetectedProtocol = 'tls' | 'tcp' | 'http' | 'unknown' | 'incomplete';

const TLS_HANDSHAKE_RECORD = 0x16;

export function detectProtocol(data: Buffer, allowTls = true): DetectedProtocol {
  if (data.length === 0) return 'incomplete';
  const first = data[0];
  if (first === TLS_HANDSHAKE_RECORD) return allowTls ? 'tls' : 'unknown';

  const compare = Math.min(data.length, TCP_PREAMBLE.length);
  let matchesPreamble = true;
  for (let i = 0; i < compare; i++) {
    if (data[i] !== TCP_PREAMBLE[i]) {
      matchesPreamble = false;
      break;
    }
  }
  if (matchesPreamble) return data.length >= TCP_PREAMBLE.length ? 'tcp' : 'incomplete';

  if (first >= 0x41 && first <= 0x5a) return 'http';
  return 'unknown';
}

export interface ClientHelloInfo {
  servername: string | null;
  alpnProtocols: string[];
}

const CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;
const EXTENSION_ALPN = 0x0010;

/**
 * Reads the SNI and ALPN extensions from a TLS ClientHello record. Returns null when the
 * bytes are not a (complete enough) ClientHello.
 */
export function parseClientHello(data: Buffer): ClientHelloInfo | null {
  if (data.length < 5 || data[0] !== TLS_HANDSHAKE_RECORD) return null;

  const recordEnd = Math.min(data.length, 5 + data.readUInt16BE(3));
  let offset = 5;
  if (offset + 4 > recordEnd || data[offset] !== CLIENT_HELLO) return null;

  const helloEnd = Math.min(recordEnd, offset + 4 + data.readUIntBE(offset + 1, 3));
  offset += 4;

  // Protocol version and random
  offset += 2 + 32;
  if (offset + 1 > helloEnd) return null;

  const sessionIdLength = data[offset];
  offset += 1 + sessionIdLength;
  if (offset + 2 > helloEnd) return null;

  const cipherSuitesLength = data.readUInt16BE(offset);
  offset += 2 + cipherSuitesLength;
  if (offset + 1 > helloEnd) return null;

  const compressionLength = data[offset];
  offset += 1 + compressionLength;

  const info: ClientHelloInfo = { servername: null, alpnProtocols: [] };
  if (offset + 2 > helloEnd) return info;

  const extensionsEnd = Math.min(helloEnd, offset + 2 + data.readUInt16BE(offset));
  offset += 2;

  while (offset + 4 <= extensionsEnd) {
    const type = data.readUInt16BE(offset);
    const length = data.readUInt16BE(offset + 2);
    offset += 4;
    const extensionEnd = offset + length;
    if (extensionEnd > extensionsEnd) break;

    if (type === EXTENSION_SERVER_NAME) {
      let cursor = offset + 2;
      while (cursor + 3 <= extensionEnd) {
        const nameType = data[cursor];
        const nameLength = data.readUInt16BE(cursor + 1);
        cursor += 3;
        if (cursor + nameLength > extensionEnd) break;
        if (nameType === 0) {
          info.servername = data.toString('utf8', cursor, cursor + nameLength);
          break;
        }
        cursor += nameLength;
      }
    } else if (type === EXTENSION_ALPN) {
      let cursor = offset + 2;
      while (cursor < extensionEnd) {
        const protocolLength = data[cursor];
        cursor += 1;
        if (protocolLength === 0 || cursor + protocolLength > extensionEnd) break;
        info.alpnProtocols.push(data.toString('utf8', cursor, cursor + protocolLength));
        cursor += protocolLength;
      }
    }

    offset = extensionEnd;
  }

  return info;
}
