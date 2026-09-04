/**
 * Password hashing.
 *
 * These are slow by design — each hash reserves ~64MB and takes ~100ms, which
 * is the entire point. A fast password hash is a broken password hash.
 */

import { describe, expect, it } from 'vitest';

import {
  checkPasswordStrength,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  needsRehash,
  verifyPassword,
} from '../src/infra/password.js';

describe('hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces a different hash every time for the same password', async () => {
    // The salt is what makes this true, and it is what makes a precomputed
    // table useless and stops one cracked hash revealing another account's.
    const a = await hashPassword('same-password-both-times');
    const b = await hashPassword('same-password-both-times');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-both-times', a)).toBe(true);
    expect(await verifyPassword('same-password-both-times', b)).toBe(true);
  });

  it('stores its own cost parameters, so they can be raised later', async () => {
    const hash = await hashPassword('whatever-goes-here');
    const [algorithm, n, r, p, salt, digest] = hash.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(65_536);
    expect(Number(r)).toBeGreaterThanOrEqual(8);
    expect(Number(p)).toBeGreaterThanOrEqual(1);
    expect((salt ?? '').length).toBeGreaterThan(10);
    expect((digest ?? '').length).toBeGreaterThan(10);
  });

  it('never contains the password itself', async () => {
    const secret = 'a-very-distinctive-passphrase-42';
    const hash = await hashPassword(secret);
    expect(hash).not.toContain(secret);
    expect(hash.toLowerCase()).not.toContain('distinctive');
  });

  it('treats unicode consistently', async () => {
    // NFKC normalisation, so a password typed with a different but equivalent
    // encoding still works - otherwise a user is locked out by their keyboard.
    const composed = 'café-passphrase';
    const decomposed = 'café-passphrase';
    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('handles a very long password without complaint', async () => {
    const long = 'x'.repeat(200);
    const hash = await hashPassword(long);
    expect(await verifyPassword(long, hash)).toBe(true);
  });
});

describe('malformed stored hashes deny access rather than throwing', () => {
  const cases: Array<[string, string | null]> = [
    ['null', null],
    ['empty', ''],
    ['not a hash at all', 'hunter2'],
    ['too few fields', 'scrypt$65536$8$1$onlyonesalt'],
    ['unknown algorithm', 'bcrypt$65536$8$1$c2FsdA==$aGFzaA=='],
    ['non-numeric cost', 'scrypt$abc$8$1$c2FsdA==$aGFzaA=='],
    ['absurd cost, which must not be honoured', 'scrypt$999999999$8$1$c2FsdA==$aGFzaA=='],
    ['empty salt', 'scrypt$65536$8$1$$aGFzaA=='],
  ];

  for (const [label, stored] of cases) {
    it(label, async () => {
      // A corrupt row must deny access, not crash the login route - and
      // certainly must not be able to ask us to allocate gigabytes.
      expect(await verifyPassword('anything', stored)).toBe(false);
    });
  }
});

describe('strength rules', () => {
  it('requires a minimum length', () => {
    expect(checkPasswordStrength('short').ok).toBe(false);
    expect(checkPasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
  });

  it('rejects the passwords people actually pick', () => {
    for (const bad of ['password', 'password123', '12345678', 'letmein1'.replace('1', ''), 'qwerty123']) {
      expect(checkPasswordStrength(bad).ok, bad).toBe(false);
    }
  });

  it('rejects anything derived from the username', () => {
    expect(checkPasswordStrength('teesta-teesta', 'teesta').ok).toBe(false);
    expect(checkPasswordStrength('MyTeestaAccount', 'teesta').ok).toBe(false);
  });

  it('rejects one repeated character, sequences and keyboard rows', () => {
    expect(checkPasswordStrength('aaaaaaaaaa').ok, 'repeated').toBe(false);
    expect(checkPasswordStrength('0123456789').ok, 'digits up').toBe(false);
    expect(checkPasswordStrength('abcdefghij').ok, 'letters up').toBe(false);
    expect(checkPasswordStrength('9876543210').ok, 'digits down').toBe(false);
    expect(checkPasswordStrength('jihgfedcba').ok, 'letters down').toBe(false);
    expect(checkPasswordStrength('qwertyuiop').ok, 'keyboard row').toBe(false);
    expect(checkPasswordStrength('asdfghjkl').ok, 'keyboard row').toBe(false);
  });

  it('rejects short passwords with almost no variety', () => {
    expect(checkPasswordStrength('abababab').ok).toBe(false);
  });

  it('accepts a decent passphrase without demanding symbols', () => {
    // No composition rules on purpose: mandatory symbols push people toward
    // predictable substitutions while blocking genuinely strong passphrases.
    expect(checkPasswordStrength('correct horse battery staple').ok).toBe(true);
    expect(checkPasswordStrength('quiet-river-lantern').ok).toBe(true);
    expect(checkPasswordStrength('Tr0ub4dor&3').ok).toBe(true);
  });

  it('gives a reason a human can act on', () => {
    const result = checkPasswordStrength('abc');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/at least 8 characters/i);
    }
  });
});

describe('rehashing', () => {
  it('leaves a current hash alone', async () => {
    expect(needsRehash(await hashPassword('some-decent-password'))).toBe(false);
  });

  it('flags a hash made at lower cost', () => {
    // The upgrade path: a successful login is the one moment we hold the
    // plaintext and can transparently re-hash at the new parameters.
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
  });

  it('flags anything it does not recognise', () => {
    expect(needsRehash('bcrypt$10$whatever')).toBe(true);
  });

  it('ignores an absent hash', () => {
    expect(needsRehash(null)).toBe(false);
  });
});
