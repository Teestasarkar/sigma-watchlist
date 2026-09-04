/**
 * Counter-based deterministic randomness.
 *
 * The simulator must be a *pure function* of (seed, key, index, stream) rather
 * than a stateful stream. That property is what lets it answer "what was
 * NVDA's close 180 sessions ago" and "what is NVDA's price right now"
 * consistently - on any process, in any order, after any restart - and it is
 * what makes the tests reproducible.
 *
 * A stateful PRNG could not do that: the answer would depend on how many
 * numbers had been drawn before it, so a quote served after a cache miss would
 * differ from the same quote served after a cache hit.
 *
 * `stream` separates independent sources of randomness. Drawing the jump
 * indicator and the jump size from the same stream would correlate them, so
 * every distinct use gets its own.
 */

/** MurmurHash3 finalizer, used here as a 32-bit integer mixer. */
function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a over a string, seeded. */
function hashString(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Uniform draw in [0, 1) for a given coordinate.
 *
 * The three integer inputs are mixed separately before being combined, so
 * adjacent indices - which is the common case, since sessions are consecutive
 * - do not produce visibly correlated output.
 */
export function uniformAt(seed: number, key: string, index: number, stream: number): number {
  const k = hashString(key, (seed ^ 0x9e3779b9) >>> 0);
  let h = mix32(k ^ mix32(Math.imul(index | 0, 0x85ebca6b)));
  h = mix32(h ^ mix32(Math.imul(stream | 0, 0xc2b2ae35)));
  // Divide by 2^32 so the result is in [0, 1).
  return h / 4294967296;
}

/**
 * Standard normal draw, via Box-Muller on two independent uniforms.
 *
 * The second uniform is taken from a derived stream rather than the next
 * index, so that consecutive `normalAt` calls at consecutive indices stay
 * independent of one another.
 */
export function normalAt(seed: number, key: string, index: number, stream: number): number {
  // Clamp away from exactly zero, where log diverges.
  const u1 = Math.max(1e-12, uniformAt(seed, key, index, stream));
  const u2 = uniformAt(seed, key, index, (stream ^ 0x5bf03635) | 0);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Uniform draw scaled into [lo, hi). */
export function rangeAt(
  seed: number,
  key: string,
  index: number,
  stream: number,
  lo: number,
  hi: number,
): number {
  return lo + (hi - lo) * uniformAt(seed, key, index, stream);
}
