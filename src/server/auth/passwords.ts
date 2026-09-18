import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LEN = 64;
// 128*N*r for N=32768, r=8 is 32 MiB, which sits at/over the default scrypt
// maxmem on Bun 1.4.2 (measured: N=32768 with the default cap throws
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS). Pass an explicit cap so the stored AND
// any future cost parameters always work; measured ~104 ms/hash on the
// deploy host (i5-6500T).
export const SCRYPT_MAXMEM = 128 * 1024 * 1024;

// Stored format: scrypt$N$r$p$saltHex$hashHex. N/r/p are stored so parameter
// changes never invalidate already-stored hashes: hashes written with the old
// N=16384 keep verifying, and re-hashing happens lazily (on the next password
// set), never as a migration.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  // maxmem explicit here too: a stored hash whose parameters need more than
  // the default cap must still verify.
  const actual = scryptSync(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return timingSafeEqual(actual, expected);
}

// A precomputed hash used when a username does not exist, so unknown and
// wrong-password logins take the same time (no user enumeration via timing).
const DUMMY_HASH = hashPassword("dummy-password-for-timing");

export function verifyDummyPassword(): boolean {
  return verifyPassword("dummy-password-for-timing", DUMMY_HASH);
}
