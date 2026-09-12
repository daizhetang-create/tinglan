// A guard against decoder runaway, not an accuracy score or global transcript deduplicator.
export function transcriptQualityReason(text) {
  if (String(text).length > 100000) return 'oversized';
  const value = String(text).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!value) return 'empty';
  if (/(.)\1{7,}/u.test(value)) return 'repetition';
  if (value.length >= 32 && /(.{2,16}?)\1{7,}/u.test(value)) return 'repetition';
  return null;
}
export function normalizedQuote(text) { return String(text).normalize('NFKC').replace(/\s+/g, ' ').trim(); }
