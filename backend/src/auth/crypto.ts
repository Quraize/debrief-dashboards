/**
 * Auth primitives: password hashing, token generation, constant-time compare.
 *
 * Deliberate choices:
 *
 *  * argon2id, not bcrypt. It is the OWASP first choice, and @node-rs/argon2
 *    ships prebuilt binaries so there is no node-gyp toolchain in the Docker
 *    image. Parameters are pinned here rather than left at library defaults so
 *    that a dependency bump cannot silently weaken them.
 *
 *  * Session tokens get SHA-256, not argon2. They are 256 bits of CSPRNG
 *    output, so there is nothing to brute-force; paying a KDF cost on every
 *    authenticated request would be a self-inflicted denial of service.
 *
 *  * Every comparison of a secret uses timingSafeEqual.
 */
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane).
 * Raising memoryCost is the meaningful lever if hardware improves; changing
 * these does not invalidate existing hashes, because the parameters are encoded
 * in the hash string itself and verification reads them from there.
 */
const ARGON_OPTIONS = {
  // `algorithm` is deliberately omitted: @node-rs/argon2 exports Algorithm as an
  // ambient const enum, which is unusable under verbatimModuleSyntax, and its
  // default is already Argon2id. Rather than hardcode the numeric value and
  // hope, tests/auth.test.ts asserts every hash begins with "$argon2id$" - the
  // assumption is checked on every CI run instead of trusted.
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A pre-computed hash of a value nobody knows, used to burn the same CPU time
 * when the account does not exist. Without it, "no such user" returns in
 * microseconds while "wrong password" takes ~50ms, and that difference is a
 * user-enumeration oracle. Moot with a single account today; correct anyway,
 * because it stops being moot the moment onboarding lands.
 */
let dummyHash: string | null = null;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }
  return argonHash(plaintext, ARGON_OPTIONS);
}

export async function verifyPassword(storedHash: string | null, plaintext: string): Promise<boolean> {
  if (!storedHash) {
    // Spend the time anyway, then fail.
    dummyHash ??= await argonHash(randomBytes(32).toString("hex"), ARGON_OPTIONS);
    await argonVerify(dummyHash, plaintext).catch(() => false);
    return false;
  }
  try {
    return await argonVerify(storedHash, plaintext);
  } catch {
    // A malformed hash in the database is a failure, never a pass.
    return false;
  }
}

/** 256 bits of CSPRNG output, URL-safe. Used for session and CSRF tokens. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What actually goes in the database. The raw token only ever lives in a cookie. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Length-safe, timing-safe equality for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Comparing digests keeps the inputs a fixed size.
  const ah = createHash("sha256").update(ab).digest();
  const bh = createHash("sha256").update(bb).digest();
  return timingSafeEqual(ah, bh);
}
