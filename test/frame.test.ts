import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  FrameParser,
  Opcode,
  encodeClosePayload,
  encodeFrame,
  encodeFrameHeader,
  encodeMaskedFrame,
  isValidCloseCode,
  type FrameParserOptions,
} from '../src/frame.js';

type Event =
  | { type: 'message'; data: string; binary: boolean }
  | { type: 'bulk'; length: number; binary: boolean }
  | { type: 'ping'; payload: string }
  | { type: 'pong'; payload: string }
  | { type: 'close'; code: number | null; reason: string }
  | { type: 'error'; code: number; reason: string };

function parse(input: Buffer | Buffer[], options: Partial<FrameParserOptions> = {}, splitAt?: number[]): Event[] {
  const events: Event[] = [];
  const parser = new FrameParser(
    { requireMask: false, maxMessageBytes: 1 << 20, maxBufferedMessageBytes: 1024, ...options },
    {
      onMessage: (data, binary) => events.push({ type: 'message', data: data.toString(binary ? 'hex' : 'utf8'), binary }),
      onBulkMessage: (length, binary) => events.push({ type: 'bulk', length, binary }),
      onPing: (payload) => events.push({ type: 'ping', payload: payload.toString() }),
      onPong: (payload) => events.push({ type: 'pong', payload: payload.toString() }),
      onClose: (code, reason) => events.push({ type: 'close', code, reason }),
      onError: (code, reason) => events.push({ type: 'error', code, reason }),
    }
  );
  const data = Array.isArray(input) ? Buffer.concat(input) : input;
  if (!splitAt) {
    parser.push(data);
  } else {
    let last = 0;
    for (const at of [...splitAt, data.length]) {
      if (at > last) parser.push(data.subarray(last, at));
      last = at;
    }
  }
  return events;
}

/** Feeds `data` one byte at a time. */
function parseBytewise(data: Buffer, options: Partial<FrameParserOptions> = {}): Event[] {
  return parse(data, options, Array.from({ length: data.length }, (_, i) => i + 1));
}

const text = (value: string, fin = true) => encodeFrame(Opcode.Text, Buffer.from(value), fin);
const binary = (bytes: Buffer, fin = true) => encodeFrame(Opcode.Binary, bytes, fin);
const continuation = (bytes: Buffer, fin = true) => encodeFrame(Opcode.Continuation, bytes, fin);

describe('encodeFrameHeader', () => {
  it.each([
    [0, 2],
    [125, 2],
    [126, 4],
    [65535, 4],
    [65536, 10],
    [2 ** 32 + 5, 10],
  ])('uses the shortest length encoding for %i bytes', (length, size) => {
    const header = encodeFrameHeader(Opcode.Binary, length);
    expect(header.length).toBe(size);
    expect(header[0]).toBe(0x82);
    if (size === 2) expect(header[1]).toBe(length);
    if (size === 4) expect(header.readUInt16BE(2)).toBe(length);
    if (size === 10) expect(Number(header.readBigUInt64BE(2))).toBe(length);
  });

  it('clears FIN for non-final fragments', () => {
    expect(encodeFrameHeader(Opcode.Text, 3, false)[0]).toBe(0x01);
  });

  it('never sets the mask bit', () => {
    for (const length of [0, 200, 70000]) expect(encodeFrameHeader(Opcode.Binary, length)[1] & 0x80).toBe(0);
  });
});

describe('encodeMaskedFrame', () => {
  it('masks the payload with the given key', () => {
    const frame = encodeMaskedFrame(Opcode.Text, Buffer.from('abcd'), new Uint8Array([1, 2, 3, 4]));
    expect(frame[1] & 0x80).toBe(0x80);
    expect([...frame.subarray(2, 6)]).toEqual([1, 2, 3, 4]);
    expect([...frame.subarray(6)]).toEqual([0x61 ^ 1, 0x62 ^ 2, 0x63 ^ 3, 0x64 ^ 4]);
  });
});

describe('encodeClosePayload', () => {
  it('writes the code and reason', () => {
    const payload = encodeClosePayload(1001, 'bye');
    expect(payload.readUInt16BE(0)).toBe(1001);
    expect(payload.subarray(2).toString()).toBe('bye');
  });

  it('truncates reasons so the frame stays within the control frame limit', () => {
    expect(encodeClosePayload(1000, 'x'.repeat(500)).length).toBe(125);
  });
});

describe('isValidCloseCode', () => {
  it.each([1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 3000, 3999, 4000, 4999])(
    'accepts %i',
    (code) => expect(isValidCloseCode(code)).toBe(true)
  );

  it.each([0, 999, 1004, 1005, 1006, 1015, 1016, 1100, 2000, 2999, 5000, 65535])('rejects %i', (code) =>
    expect(isValidCloseCode(code)).toBe(false)
  );
});

describe('FrameParser messages', () => {
  it('parses text and binary messages', () => {
    expect(parse([text('hello'), binary(Buffer.from([1, 2, 3]))])).toEqual([
      { type: 'message', data: 'hello', binary: false },
      { type: 'message', data: '010203', binary: true },
    ]);
  });

  it('parses empty messages', () => {
    expect(parse([text(''), binary(Buffer.alloc(0))])).toEqual([
      { type: 'message', data: '', binary: false },
      { type: 'message', data: '', binary: true },
    ]);
  });

  it('unmasks masked frames', () => {
    const frame = encodeMaskedFrame(Opcode.Text, Buffer.from('masked text'), new Uint8Array([9, 8, 7, 6]));
    expect(parse(frame, { requireMask: true })).toEqual([{ type: 'message', data: 'masked text', binary: false }]);
  });

  it('accepts unmasked frames when masks are optional and masked ones too', () => {
    expect(parse([text('a'), encodeMaskedFrame(Opcode.Text, Buffer.from('b'))])).toEqual([
      { type: 'message', data: 'a', binary: false },
      { type: 'message', data: 'b', binary: false },
    ]);
  });

  it('reassembles fragmented messages', () => {
    expect(parse([text('he', false), continuation(Buffer.from('ll'), false), continuation(Buffer.from('o'))])).toEqual([
      { type: 'message', data: 'hello', binary: false },
    ]);
  });

  it('delivers control frames interleaved with fragments', () => {
    expect(
      parse([
        text('a', false),
        encodeFrame(Opcode.Ping, Buffer.from('p')),
        continuation(Buffer.from('b'), false),
        encodeFrame(Opcode.Pong, Buffer.from('q')),
        continuation(Buffer.from('c')),
      ])
    ).toEqual([
      { type: 'ping', payload: 'p' },
      { type: 'pong', payload: 'q' },
      { type: 'message', data: 'abc', binary: false },
    ]);
  });

  it('accepts fragmented messages with empty fragments', () => {
    expect(parse([binary(Buffer.alloc(0), false), continuation(Buffer.from([7]), false), continuation(Buffer.alloc(0))])).toEqual([
      { type: 'message', data: '07', binary: true },
    ]);
  });

  it('accepts UTF-8 split across fragments', () => {
    const euro = Buffer.from('€');
    expect(parse([encodeFrame(Opcode.Text, euro.subarray(0, 1), false), continuation(euro.subarray(1))])).toEqual([
      { type: 'message', data: '€', binary: false },
    ]);
  });

  it('parses 16-bit and 64-bit payload lengths', () => {
    const medium = randomBytes(300);
    const large = randomBytes(70000);
    const events = parse([binary(medium), binary(large)], { maxBufferedMessageBytes: 100000 });
    expect(events).toEqual([
      { type: 'message', data: medium.toString('hex'), binary: true },
      { type: 'message', data: large.toString('hex'), binary: true },
    ]);
  });
});

describe('FrameParser bulk messages', () => {
  it('buffers messages exactly at the threshold and counts larger ones', () => {
    const events = parse([binary(Buffer.alloc(128)), binary(Buffer.alloc(129)), text('x'.repeat(129))], {
      maxBufferedMessageBytes: 128,
    });
    expect(events).toEqual([
      { type: 'message', data: '00'.repeat(128), binary: true },
      { type: 'bulk', length: 129, binary: true },
      { type: 'bulk', length: 129, binary: false },
    ]);
  });

  it('switches a fragmented message to bulk once it crosses the threshold', () => {
    const events = parse(
      [binary(Buffer.alloc(100), false), continuation(Buffer.alloc(100), false), continuation(Buffer.alloc(100))],
      { maxBufferedMessageBytes: 128 }
    );
    expect(events).toEqual([{ type: 'bulk', length: 300, binary: true }]);
  });

  it('counts bulk messages of every length encoding', () => {
    const events = parse([binary(Buffer.alloc(200)), binary(Buffer.alloc(70000)), binary(Buffer.alloc(1 << 20))], {
      maxBufferedMessageBytes: 128,
      maxMessageBytes: 1 << 21,
    });
    expect(events).toEqual([
      { type: 'bulk', length: 200, binary: true },
      { type: 'bulk', length: 70000, binary: true },
      { type: 'bulk', length: 1 << 20, binary: true },
    ]);
  });

  it('counts masked bulk payloads without unmasking them', () => {
    const frame = encodeMaskedFrame(Opcode.Binary, Buffer.alloc(5000, 1));
    expect(parse(frame, { requireMask: true, maxBufferedMessageBytes: 128 })).toEqual([
      { type: 'bulk', length: 5000, binary: true },
    ]);
  });

  it('does not validate UTF-8 in bulk text messages', () => {
    const invalid = encodeFrame(Opcode.Text, Buffer.alloc(200, 0xff));
    expect(parse(invalid, { maxBufferedMessageBytes: 128 })).toEqual([{ type: 'bulk', length: 200, binary: false }]);
  });
});

describe('FrameParser chunk boundaries', () => {
  const stream = Buffer.concat([
    text('hello'),
    encodeMaskedFrame(Opcode.Text, Buffer.from('masked'), new Uint8Array([5, 6, 7, 8])),
    binary(Buffer.alloc(300, 3)),
    encodeFrame(Opcode.Ping, Buffer.from('ping')),
    binary(Buffer.alloc(70000, 4), false),
    continuation(Buffer.alloc(10, 4)),
    encodeMaskedFrame(Opcode.Binary, Buffer.alloc(200, 9), new Uint8Array([1, 3, 5, 7])),
    encodeFrame(Opcode.Close, encodeClosePayload(1000, 'done')),
  ]);
  const options = { maxBufferedMessageBytes: 256 };
  const expected = parse(stream, options);

  it('produces the expected events in one chunk', () => {
    expect(expected).toEqual([
      { type: 'message', data: 'hello', binary: false },
      { type: 'message', data: 'masked', binary: false },
      { type: 'bulk', length: 300, binary: true },
      { type: 'ping', payload: 'ping' },
      { type: 'bulk', length: 70010, binary: true },
      { type: 'message', data: '09'.repeat(200), binary: true },
      { type: 'close', code: 1000, reason: 'done' },
    ]);
  });

  it('produces the same events when fed one byte at a time', () => {
    expect(parseBytewise(stream, options)).toEqual(expected);
  });

  it('produces the same events for every single split point', () => {
    for (let at = 1; at < stream.length; at += at < 400 ? 1 : 997) {
      expect(parse(stream, options, [at])).toEqual(expected);
    }
  });

  it('produces the same events for random splits', () => {
    for (let round = 0; round < 200; round++) {
      const points = Array.from({ length: 1 + Math.floor(Math.random() * 20) }, () =>
        Math.floor(Math.random() * stream.length)
      ).sort((a, b) => a - b);
      expect(parse(stream, options, points)).toEqual(expected);
    }
  });
});

describe('FrameParser control frames', () => {
  it('reports ping and pong payloads', () => {
    expect(parse([encodeFrame(Opcode.Ping), encodeFrame(Opcode.Pong, Buffer.from('x'))])).toEqual([
      { type: 'ping', payload: '' },
      { type: 'pong', payload: 'x' },
    ]);
  });

  it('accepts a 125 byte control payload', () => {
    expect(parse(encodeFrame(Opcode.Ping, Buffer.alloc(125, 0x61)))).toEqual([{ type: 'ping', payload: 'a'.repeat(125) }]);
  });

  it('reports an empty close frame with a null code', () => {
    expect(parse(encodeFrame(Opcode.Close))).toEqual([{ type: 'close', code: null, reason: '' }]);
  });

  it('reports the close code and reason', () => {
    expect(parse(encodeFrame(Opcode.Close, encodeClosePayload(4000, 'custom')))).toEqual([
      { type: 'close', code: 4000, reason: 'custom' },
    ]);
  });
});

describe('FrameParser protocol errors', () => {
  const errorOf = (input: Buffer | Buffer[], options: Partial<FrameParserOptions> = {}) => {
    const events = parse(input, options);
    const error = events.find((event) => event.type === 'error');
    return error && 'code' in error ? error.code : null;
  };

  it('requires masks when configured', () => {
    expect(errorOf(text('x'), { requireMask: true })).toBe(CloseCode.ProtocolError);
  });

  it.each([0x40, 0x20, 0x10])('rejects reserved bit %s', (bit) => {
    const frame = text('x');
    frame[0] |= bit;
    expect(errorOf(frame)).toBe(CloseCode.ProtocolError);
  });

  it.each([3, 4, 5, 6, 7, 11, 12, 13, 14, 15])('rejects reserved opcode %i', (opcode) => {
    expect(errorOf(encodeFrame(opcode, Buffer.from('x')))).toBe(CloseCode.ProtocolError);
  });

  it('rejects fragmented control frames', () => {
    expect(errorOf(encodeFrame(Opcode.Ping, Buffer.alloc(0), false))).toBe(CloseCode.ProtocolError);
  });

  it('rejects control frames over 125 bytes', () => {
    expect(errorOf(encodeFrame(Opcode.Ping, Buffer.alloc(126)))).toBe(CloseCode.ProtocolError);
  });

  it('rejects a continuation without a message', () => {
    expect(errorOf(continuation(Buffer.from('x')))).toBe(CloseCode.ProtocolError);
  });

  it('rejects a new message while one is fragmented', () => {
    expect(errorOf([text('a', false), text('b')])).toBe(CloseCode.ProtocolError);
  });

  it('rejects 64-bit lengths with the most significant bit set', () => {
    const header = Buffer.from([0x82, 127, 0x80, 0, 0, 0, 0, 0, 0, 1]);
    expect(errorOf(header)).toBe(CloseCode.ProtocolError);
  });

  it('rejects messages over the size limit, including fragmented ones', () => {
    expect(errorOf(binary(Buffer.alloc(101)), { maxMessageBytes: 100 })).toBe(CloseCode.MessageTooBig);
    expect(errorOf([binary(Buffer.alloc(60), false), continuation(Buffer.alloc(60))], { maxMessageBytes: 100 })).toBe(
      CloseCode.MessageTooBig
    );
  });

  it('rejects oversized lengths before any payload arrives', () => {
    const header = encodeFrameHeader(Opcode.Binary, 2 ** 40);
    expect(errorOf(header, { maxMessageBytes: 1 << 20 })).toBe(CloseCode.MessageTooBig);
  });

  it('rejects invalid UTF-8 in buffered text messages', () => {
    expect(errorOf(encodeFrame(Opcode.Text, Buffer.from([0xc3, 0x28])))).toBe(CloseCode.InvalidPayload);
    expect(errorOf(encodeFrame(Opcode.Text, Buffer.from([0xed, 0xa0, 0x80])))).toBe(CloseCode.InvalidPayload);
  });

  it('rejects a one byte close payload', () => {
    expect(errorOf(encodeFrame(Opcode.Close, Buffer.from([3])))).toBe(CloseCode.ProtocolError);
  });

  it.each([0, 999, 1004, 1005, 1006, 1015, 2000, 5000])('rejects close code %i', (code) => {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    expect(errorOf(encodeFrame(Opcode.Close, payload))).toBe(CloseCode.ProtocolError);
  });

  it('rejects a close reason that is not UTF-8', () => {
    expect(errorOf(encodeFrame(Opcode.Close, Buffer.from([0x03, 0xe8, 0xff])))).toBe(CloseCode.InvalidPayload);
  });

  it('stops after the first error', () => {
    const events = parse([encodeFrame(5, Buffer.alloc(0)), text('ignored')]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });
});

describe('FrameParser fuzzing', () => {
  it('never throws on random input and reports at most one error', () => {
    for (let round = 0; round < 2000; round++) {
      const input = randomBytes(1 + Math.floor(Math.random() * 300));
      let events: Event[] = [];
      expect(() => {
        events = parse(input, { requireMask: Math.random() < 0.5, maxMessageBytes: 4096, maxBufferedMessageBytes: 64 });
      }).not.toThrow();
      expect(events.filter((event) => event.type === 'error').length).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips random valid frame sequences under random splits', () => {
    for (let round = 0; round < 100; round++) {
      const frames: Buffer[] = [];
      const expected: Event[] = [];
      for (let i = 0; i < 20; i++) {
        const size = [0, 1, 50, 125, 126, 300, 65535, 65536][Math.floor(Math.random() * 8)];
        const payload = randomBytes(size);
        const maskIt = Math.random() < 0.5;
        frames.push(maskIt ? encodeMaskedFrame(Opcode.Binary, payload, randomBytes(4)) : binary(payload));
        expected.push(
          size <= 1000
            ? { type: 'message', data: payload.toString('hex'), binary: true }
            : { type: 'bulk', length: size, binary: true }
        );
      }
      const stream = Buffer.concat(frames);
      const points = Array.from({ length: 30 }, () => Math.floor(Math.random() * stream.length)).sort((a, b) => a - b);
      expect(parse(stream, { maxBufferedMessageBytes: 1000 }, points)).toEqual(expected);
    }
  });
});
