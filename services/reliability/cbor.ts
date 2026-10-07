/**
 * @fileoverview The small CBOR subset (RFC 8949) that CIP-30 wallet
 * signatures use: integers, byte and text strings, arrays, maps, tags,
 * booleans, and null. Indefinite lengths and floats are refused.
 */

export type CborValue =
  number|bigint|Uint8Array|string|boolean|null|CborValue[]|CborMap|CborTag;

/** A CBOR map. Keys keep their CBOR type, so 1 and "1" stay apart. */
export class CborMap {
  constructor(readonly entries: Array<[CborValue, CborValue]>) {}

  get(key: number|string): CborValue|undefined {
    return this.entries.find(([k]) => k === key)?.[1];
  }
}

export class CborTag {
  constructor(readonly tag: number, readonly value: CborValue) {}
}

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CborError';
  }
}

const MAX_DEPTH = 16;

/** Decodes exactly one value. Trailing bytes are an error. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  let offset = 0;
  const need = (count: number) => {
    if (offset + count > bytes.length) throw new CborError('CBOR ends early');
  };
  const length = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (!size) throw new CborError('indefinite or reserved CBOR length');
    need(size);
    let value = 0n;
    for (let i = 0; i < size; i++) value = (value << 8n) | BigInt(bytes[offset + i] as number);
    offset += size;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('CBOR length is too large');
    return Number(value);
  };
  const read = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new CborError('CBOR is nested too deeply');
    need(1);
    const head = bytes[offset++] as number;
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 0: return length(info);
      case 1: return -1 - length(info);
      case 2: case 3: {
        const size = length(info);
        need(size);
        const chunk = bytes.slice(offset, offset + size);
        offset += size;
        return major === 2 ? chunk : new TextDecoder('utf-8', {fatal: true}).decode(chunk);
      }
      case 4: {
        const size = length(info);
        const items: CborValue[] = [];
        for (let i = 0; i < size; i++) items.push(read(depth + 1));
        return items;
      }
      case 5: {
        const size = length(info);
        const entries: Array<[CborValue, CborValue]> = [];
        for (let i = 0; i < size; i++) entries.push([read(depth + 1), read(depth + 1)]);
        return new CborMap(entries);
      }
      case 6: return new CborTag(length(info), read(depth + 1));
      default:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError(`unsupported CBOR simple value ${info}`);
    }
  };
  const value = read(0);
  if (offset !== bytes.length) throw new CborError('CBOR has trailing bytes');
  return value;
}

function head(major: number, size: number): number[] {
  if (size < 24) return [(major << 5) | size];
  if (size < 0x100) return [(major << 5) | 24, size];
  if (size < 0x10000) return [(major << 5) | 25, size >> 8, size & 0xff];
  return [(major << 5) | 26, (size >>> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
}

/** Encodes non-negative or negative safe integers, strings, bytes, arrays, and maps with simple keys. */
export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  const write = (item: CborValue) => {
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new CborError('only safe integers can be encoded');
      out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)));
    } else if (item instanceof Uint8Array) {
      out.push(...head(2, item.length), ...item);
    } else if (typeof item === 'string') {
      const text = new TextEncoder().encode(item);
      out.push(...head(3, text.length), ...text);
    } else if (Array.isArray(item)) {
      out.push(...head(4, item.length));
      item.forEach(write);
    } else if (item instanceof CborMap) {
      out.push(...head(5, item.entries.length));
      for (const [key, entry] of item.entries) { write(key); write(entry); }
    } else if (typeof item === 'boolean') {
      out.push(item ? 0xf5 : 0xf4);
    } else if (item === null) {
      out.push(0xf6);
    } else {
      throw new CborError('unsupported value for CBOR encoding');
    }
  };
  write(value);
  return Uint8Array.from(out);
}
