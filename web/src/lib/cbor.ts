/*
 * The CBOR encoding subset that wallet signatures need: integers, byte and
 * text strings, arrays, and maps. https://www.rfc-editor.org/rfc/rfc8949
 */

export type Cbor = number | Uint8Array | string | boolean | Cbor[] | CborMapValue

export interface CborMapValue {
  map: Array<[Cbor, Cbor]>
}

export const cborMap = (map: Array<[Cbor, Cbor]>): CborMapValue => ({map})

function head(major: number, size: number): number[] {
  if (size < 24) return [(major << 5) | size]
  if (size < 0x100) return [(major << 5) | 24, size]
  if (size < 0x10000) return [(major << 5) | 25, size >> 8, size & 0xff]
  return [(major << 5) | 26, (size >>> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff]
}

export function encodeCbor(value: Cbor): Uint8Array {
  const out: number[] = []
  const write = (item: Cbor) => {
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new Error('only safe integers can be encoded')
      out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)))
    } else if (item instanceof Uint8Array) {
      out.push(...head(2, item.length), ...item)
    } else if (typeof item === 'string') {
      const text = new TextEncoder().encode(item)
      out.push(...head(3, text.length), ...text)
    } else if (Array.isArray(item)) {
      out.push(...head(4, item.length))
      item.forEach(write)
    } else if (typeof item === 'boolean') {
      out.push(item ? 0xf5 : 0xf4)
    } else {
      out.push(...head(5, item.map.length))
      for (const [key, entry] of item.map) { write(key); write(entry) }
    }
  }
  write(value)
  return Uint8Array.from(out)
}
