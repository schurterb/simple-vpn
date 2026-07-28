import canonicalize from 'canonicalize';

export function jcsCanonicalize(obj: unknown): Buffer {
  const result = canonicalize(obj);
  if (result === undefined) {
    throw new Error('JCS canonicalization failed');
  }
  return Buffer.from(result, 'utf-8');
}

export function jcsCanonicalizeString(obj: unknown): string {
  const result = canonicalize(obj);
  if (result === undefined) {
    throw new Error('JCS canonicalization failed');
  }
  return result;
}
