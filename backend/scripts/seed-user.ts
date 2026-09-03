/**
 * Creates or rotates the single shared account (D11).
 *
 *   DATABASE_URL=... npx tsx scripts/seed-user.ts <email> [role]
 *   printf 'the-password\n' | DATABASE_URL=... npx tsx scripts/seed-user.ts <email>
 *
 * The password is never taken from argv: process arguments are visible to every
 * other process on the machine through `ps` and /proc.
 *
 * This is deliberately a script rather than an API route. Under D11 there is no
 * self-service registration or password reset, so rotating the credential is an
 * operational act performed by someone with database access.
 */
import { createInterface, type Interface } from "node:readline";
import pg from "pg";
import { hashPassword } from "../src/auth/crypto.js";
import { ROLES as VALID_ROLES } from "@allied/shared/constants";

/**
 * Prompts without echoing. readline writes each keystroke through
 * `_writeToOutput`; replacing it hides the characters while leaving backspace
 * and the rest of the line editing intact. A password left on screen ends up in
 * a screen share, a scrollback buffer, or a photo of someone's monitor.
 */
function askHidden(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    const muted = rl as unknown as { _writeToOutput: (s: string) => void };
    const original = muted._writeToOutput;
    muted._writeToOutput = () => {};
    rl.question("", (answer) => {
      muted._writeToOutput = original;
      process.stderr.write("\n");
      resolve(answer);
    });
  });
}

/**
 * Reads the password from a terminal or a pipe.
 *
 * A single readline interface serves both prompts. Creating a second one after
 * the first closes leaves stdin already consumed, so a piped password hangs
 * forever — which is precisely how this failed the first time it ran
 * non-interactively.
 *
 * Piped input skips confirmation: there is nothing to mistype against.
 */
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const firstLine = Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
    const trimmed = firstLine.trim();
    if (!trimmed) throw new Error("no password received on stdin");
    return trimmed;
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    const first = (await askHidden(rl, "Password (min 12 chars, not echoed): ")).trim();
    const second = (await askHidden(rl, "Confirm: ")).trim();
    if (first !== second) throw new Error("passwords do not match");
    return first;
  } finally {
    rl.close();
  }
}

const email = process.argv[2];
const role = process.argv[3] ?? "admin";
if (!email) throw new Error("usage: seed-user.ts <email> [role]");
if (!VALID_ROLES.includes(role)) throw new Error(`role must be one of: ${VALID_ROLES.join(", ")}`);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const password = await readPassword();
const hash = await hashPassword(password); // throws below 12 characters

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const { rows } = await pool.query<{ id: string; created: boolean }>(
    `INSERT INTO app_user (email, full_name, role, password_hash, password_changed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           password_changed_at = now(),
           failed_login_attempts = 0,
           locked_until = NULL
     RETURNING id, (xmax = 0) AS created`,
    [email, email.split("@")[0], role, hash],
  );
  const result = rows[0]!;

  // Rotating a password must invalidate existing sessions, or the old
  // credential effectively still works for anyone already signed in.
  const revoked = await pool.query(
    `UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [result.id],
  );

  console.log(`${result.created ? "created" : "updated"} ${email} (${role})`);
  if ((revoked.rowCount ?? 0) > 0) {
    console.log(`revoked ${revoked.rowCount} existing session(s)`);
  }
  if (!result.created) {
    console.log("note: TOTP enrollment is unchanged — rotate it separately if needed");
  }
} finally {
  await pool.end();
}
