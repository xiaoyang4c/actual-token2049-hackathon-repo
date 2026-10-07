/**
 * @fileoverview RFC 8785 JSON Canonicalization Scheme (JCS).
 * MIP-004 requires JCS for the Masumi input hash. The lifecycle also uses
 * it for every byte string that a party signs or hashes.
 */

/** Serializes a JSON value in canonical form. Rejects values JCS cannot represent. */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JCS rejects non-finite numbers');
      // ECMAScript Number-to-String is the RFC 8785 section 3.2.2.3 serialization.
      return JSON.stringify(value);
    case 'string':
      return serializeString(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalize(item))).join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('JCS accepts plain objects only; convert dates and bigints to strings');
      }
      const record = value as {[key: string]: unknown};
      // The default sort compares UTF-16 code units, as RFC 8785 section 3.2.3 requires.
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${serializeString(key)}:${canonicalize(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS rejects the type ${typeof value}`);
  }
}

function serializeString(text: string): string {
  if (!text.isWellFormed()) throw new TypeError('JCS rejects a lone surrogate');
  // JSON.stringify escapes the RFC 8785 section 3.2.2.2 characters with lowercase hex.
  return JSON.stringify(text);
}
