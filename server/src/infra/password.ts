/**
 * Password hashing and verification.
 *
 * Uses **scrypt** from `node:crypto`. The alternative worth considering was
 * argon2id, which is the current first recommendation - but it needs a native
 * module, and a native build step is its own class of deployment failure. scrypt
 * is memory-hard, in the standard library, and explicitly acceptable at these
 * parameters; the honest trade is a slightly older primitive for a dependency
 * that cannot fail to compile.
 *
 * Four details here are not decoration:
 *
 *  1. **A per-password random salt.** Two people choosing the same password get
 *     different hashes, so one cracked hash reveals nothing about the other and
 *     a precomputed table is useless.
 *  2. **Self-describing hashes.** The cost parameters are stored *in* the hash
 *     string, so they can be raised later without invalidating every existing
 *     password - old hashes keep verifying under their own parameters.
 *  3. **Constant-time comparison.** A byte-by-byte early exit leaks how much of
 *     a guess was correct, which turns cracking into a per-character search.
 *  4. **A concurrency gate.** Memory-hard by definition means expensive: each
 *     hash reserves ~64MB. Without a gate, a burst of logins is a trivial
 *     memory-exhaustion attack on a small instance.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Cost parameters. N=65536, r=8, p=1 is the OWASP minimum for scrypt and costs
 * roughly 64MB and ~100ms per hash on modest hardware - slow enough to make
 * offline guessing expensive, fast enough that a login does not feel broken.
 */
const N = 65_536;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** scrypt needs headroom above 128 * N * r bytes, which is ~64MB here. */
const MAX_MEM = 96 * 1024 * 1024;

const ALGORITHM = 'scrypt';

/**
 * Cap concurrent hashes.
 *
 * Each one reserves ~64MB. Four at once is 256MB, which is already most of a
 * small instance - so requests queue rather than the process being OOM-killed
 * by anyone who can send a few login attempts at the same time.
 */
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  let released = false;
  return () => {
    // Guard against a double release, which would corrupt the count and
    // eventually let the gate through more work than it should.
    if (released) return;
    released = true;
    active--;
    const next = waiting.shift();
    if (next) next();
  };
}

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LEN,
      { N, r: R, p: P, maxmem: MAX_MEM },
      (err, derived) => (err ? reject(err) : resolve(derived)),
    );
  });
}

/**
 * Hash a password into a self-describing string:
 * `scrypt$65536$8$1$<salt-b64>$<hash-b64>`
 */
export async function hashPassword(password: string): Promise<string> {
  const release = await acquire();
  try {
    const salt = randomBytes(SALT_LEN);
    const derived = await scryptAsync(password, salt);
    return [ALGORITHM, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
  } finally {
    release();
  }
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for anything malformed rather than throwing: a corrupt row
 * should deny access, not crash the login route.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  // Refuse absurd stored parameters; a hostile row must not be able to ask us
  // to allocate gigabytes.
  if (n > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const release = await acquire();
  try {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password.normalize('NFKC'),
        salt,
        expected.length,
        { N: n, r, p, maxmem: MAX_MEM },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });

    // Lengths must match before timingSafeEqual, which throws otherwise.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  } finally {
    release();
  }
}

/**
 * Burn roughly the same amount of time as a real verification, for a handle
 * that does not exist.
 *
 * Without this, an unknown handle returns in microseconds and a known one takes
 * ~100ms - so anyone can enumerate which accounts exist just by timing the
 * responses. The work is deliberately wasted.
 */
export async function fakeVerify(): Promise<void> {
  // Built on first use rather than at import, so the ~100ms cost lands on a
  // failed login rather than on every process start.
  dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword('not-a-real-password', dummyHash);
}

/** A throwaway hash to verify against for accounts that do not exist. */
let dummyHash: string | null = null;

// ─────────────────────────────────────────────────────── strength

/**
 * The passwords that actually get chosen.
 *
 * A full breach-corpus check (k-anonymity against Pwned Passwords) would be
 * better and is the right thing for a real product; it needs a network call on
 * the registration path, which this deliberately avoids. This list covers the
 * overwhelming majority of what a demo would otherwise accept.
 */
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyui', 'letmein', 'welcome', 'welcome1', 'admin123',
  'iloveyou', 'sunshine', 'princess', 'football', 'baseball', 'trustno1',
  'dragon123', 'monkey123', 'abc12345', 'passw0rd', 'p@ssword', 'p@ssw0rd',
  'changeme', 'secret123', 'starwars', 'whatever', 'zaq12wsx', 'asdfghjk',
]);

/** Rows of a QWERTY keyboard, for catching `asdfghjkl` and friends. */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

const reverse = (s: string): string => [...s].reverse().join('');

/**
 * Is this a straight run of consecutive characters?
 *
 * A monotonic character-code walk rather than a list of literal sequences, so
 * it catches `0123456789`, `abcdefghij`, `9876543210` and `zyxwvutsrq` alike -
 * and anything else of that shape that nobody thought to add to a list.
 */
function isSequential(s: string): boolean {
  if (s.length < 4) return false;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < s.length; i++) {
    const delta = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (delta !== 1) ascending = false;
    if (delta !== -1) descending = false;
    if (!ascending && !descending) return false;
  }
  return ascending || descending;
}

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export interface PasswordProblem {
  ok: false;
  reason: string;
}

export type PasswordCheck = { ok: true } | PasswordProblem;

/**
 * Reject the passwords that are genuinely dangerous, and nothing else.
 *
 * No mandatory symbols or mixed case: composition rules are known to push
 * people toward predictable substitutions (`Password1!`) while blocking
 * genuinely strong passphrases. Length, a deny-list, and rejecting anything
 * derived from the handle catch far more real risk.
 */
export function checkPasswordStrength(password: string, handle?: string): PasswordCheck {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `Keep it under ${MAX_PASSWORD_LENGTH} characters.` };
  }

  const lower = password.toLowerCase();

  if (COMMON.has(lower)) {
    return { ok: false, reason: 'That is one of the most commonly used passwords. Pick another.' };
  }

  if (handle && handle.trim() !== '') {
    const h = handle.toLowerCase().trim();
    if (lower === h || lower.includes(h) || h.includes(lower)) {
      return { ok: false, reason: 'Your password cannot be based on your username.' };
    }
  }

  // A single repeated character, however long.
  if (/^(.)\1+$/.test(password)) {
    return { ok: false, reason: 'That is one character repeated. Pick something else.' };
  }

  // A straight run of consecutive characters, forwards or backwards.
  if (isSequential(password)) {
    return { ok: false, reason: 'That is a straight sequence. Pick something else.' };
  }

  // A single unbroken row of the keyboard.
  if (KEYBOARD_ROWS.some((row) => row.includes(lower) || row.includes(reverse(lower)))) {
    return { ok: false, reason: 'That is one row of the keyboard. Pick something else.' };
  }

  // Very low variety over a short password is guessable regardless of rules.
  if (password.length < 12 && new Set(password).size < 5) {
    return { ok: false, reason: 'Use a few more different characters, or make it longer.' };
  }

  return { ok: true };
}

/**
 * Whether a stored hash should be re-hashed at the current parameters.
 *
 * Called after a successful login: if the cost parameters have been raised
 * since the password was set, this is the one moment we hold the plaintext and
 * can transparently upgrade it.
 */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return true;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}
