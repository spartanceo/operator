/**
 * Local deterministic KB embedder — the SQLite fallback when no Ollama or cloud
 * embedding backend is configured.
 *
 * Bag-of-words hash projected into a fixed `EMBED_DIM` float vector,
 * sublinear-TF weighted, then L2-normalised so dot product == cosine similarity.
 * Uses FNV-1a 32-bit hash — reproducible byte-for-byte, no external deps.
 *
 * This module is intentionally pure (no DB, no network, no side effects) so
 * both `kb.service` and `kb-reindex.service` can import it without creating
 * a circular dependency.
 */

export const EMBED_DIM = 256;

/** FNV-1a 32-bit hash — small, fast, deterministic, no crypto strength needed. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// tier-review: bounded — fixed 39-element English stop-word list, never grows.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "of", "to",
  "in", "on", "at", "by", "for", "with", "is", "are", "was", "were", "be",
  "been", "being", "this", "that", "these", "those", "it", "its", "as",
  "from", "into", "about", "we", "you", "i", "they", "he", "she",
]);

/**
 * Tokenise a string for the bag-of-words embedding. Lower-cased, alpha-
 * numeric runs only, stop-words removed, max length per token capped to
 * keep the loop bounded under adversarial input.
 */
export function tokenise(text: string): string[] {
  const out: string[] = [];
  const lowered = text.toLowerCase();
  let buf = "";
  for (let i = 0; i < lowered.length; i++) {
    const c = lowered.charCodeAt(i);
    const isAlphaNum =
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x61 && c <= 0x7a); // a-z
    if (isAlphaNum) {
      buf += lowered[i];
      if (buf.length > 32) buf = buf.slice(0, 32);
    } else {
      if (buf.length >= 2 && !STOP_WORDS.has(buf)) out.push(buf);
      buf = "";
    }
  }
  if (buf.length >= 2 && !STOP_WORDS.has(buf)) out.push(buf);
  return out;
}

/**
 * Project a document into a fixed-dimension L2-normalised float vector.
 * Sublinear TF weighting (1 + log(count)) reduces the influence of a single
 * repeated word, and the FNV-1a hash deterministically picks the bucket so
 * tests can assert exact rankings without seeded RNG.
 */
export function embedLocal(text: string): number[] {
  const tokens = tokenise(text);
  if (tokens.length === 0) return new Array(EMBED_DIM).fill(0);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const [token, count] of counts) {
    const bucket = fnv1a(token) % EMBED_DIM;
    const sign = (fnv1a(token + "_sgn") & 1) === 0 ? 1 : -1;
    const weight = 1 + Math.log(1 + count);
    v[bucket] = (v[bucket] ?? 0) + sign * weight;
  }
  // L2 normalise so cosine == dot product.
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < EMBED_DIM; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}
