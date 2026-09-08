/**
 * Debrief reminder emails: the rule, the exclusions, once-only sending, the
 * failure path, and the email itself. The mailer is a fake; the database is real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  isQuietHours, composeReminder, reminderSchedule, findDueReminders, runDebriefReminders, sendTestReminder, reminderStatus,
} from "../src/reminders/debriefReminders.js";
import { mailerConfig, type Mailer, type MailMessage } from "../src/reminders/mailer.js";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";

const reachable = await pgReachable();
requirePg(reachable);

// Tuesday 2026-09-08 14:00 Eastern (18:00 UTC).
const NOW = new Date("2026-09-08T18:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function fakeMailer(opts: { failFor?: string } = {}): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    from: "Allied Debriefs <test@example.com>", sent,
    async send(m) { if (opts.failFor && m.to === opts.failFor) throw new Error("550 mailbox unavailable"); sent.push(m); return { messageId: `<${sent.length}@test>` }; },
  };
}

describe("quiet hours", () => {
  it("is quiet from 9 PM to 7 AM Eastern", () => {
    expect(isQuietHours(new Date("2026-09-09T01:30:00Z"))).toBe(true);  // 9:30 PM EDT
    expect(isQuietHours(new Date("2026-09-09T10:30:00Z"))).toBe(true);  // 6:30 AM EDT
    expect(isQuietHours(new Date("2026-09-09T11:00:00Z"))).toBe(false); // 7:00 AM EDT
    expect(isQuietHours(NOW)).toBe(false);                               // 2 PM
    expect(isQuietHours(new Date("2026-09-09T00:59:00Z"))).toBe(false); // 8:59 PM EDT
  });
});

describe("mailer config / schedule gate", () => {
  it("is off without the switch, and off without a mailbox", () => {
    expect(reminderSchedule({}).enabled).toBe(false);
    expect(reminderSchedule({ DEBRIEF_REMINDERS_ENABLED: "true" })).toMatchObject({ enabled: false, reason: "SMTP_USER not set" });
    expect(reminderSchedule({ DEBRIEF_REMINDERS_ENABLED: "true", SMTP_USER: "n@x.com" })).toMatchObject({ enabled: false, reason: "SMTP_PASSWORD not set" });
    expect(reminderSchedule({ DEBRIEF_REMINDERS_ENABLED: "true", SMTP_USER: "n@x.com", SMTP_PASSWORD: "p" })).toMatchObject({ enabled: true, cron: "*/15 * * * *" });
  });
  it("defaults to Gmail over TLS and never exposes the password", () => {
    const c = mailerConfig({ SMTP_USER: "n@x.com", SMTP_PASSWORD: "secret" });
    expect(c).toMatchObject({ configured: true, host: "smtp.gmail.com", port: 465, secure: true, from: "Allied Debriefs <n@x.com>" });
    expect(JSON.stringify(c)).not.toContain("secret");
  });
});

describe("composeReminder", () => {
  const content = composeReminder({
    customer_name: "Smith Household", location: null, address: "540 Clinton Ave", city: "Wyckoff",
    starts_at: new Date("2026-09-08T22:30:00Z"), sales_rep: "Jason Malarchak", appointment_id: "abc-123", crm_lead_id: "L-77", division: "ACR Roofing Division",
  }, { baseUrl: "https://debrief.example.com", supportContact: "IT / Automation Support" });

  it("names the appointment on the office clock and links to the pre-filled form", () => {
    expect(content.subject).toBe("Debrief needed: Smith Household — 09/08/2026 at 6:30 PM");
    expect(content.debriefUrl).toBe("https://debrief.example.com/submit?appointment_id=abc-123");
    expect(content.text).toContain("Hi Jason,");
    expect(content.text).toContain("540 Clinton Ave, Wyckoff");
    expect(content.html).toContain(">Submit Debrief<");
  });
  it("tells a rep without access how to get it", () => {
    for (const body of [content.text, content.html]) {
      expect(body).toMatch(/do not have access to our platform/);
      expect(body).toContain("IT / Automation Support");
    }
  });
  it("falls back to the queue when there is no appointment row to pre-fill", () => {
    const c = composeReminder({ customer_name: null, location: "1 Main St", address: null, city: null, starts_at: NOW, sales_rep: "", appointment_id: null, crm_lead_id: null, division: null },
      { baseUrl: "https://x", supportContact: "IT" });
    expect(c.debriefUrl).toBe("https://x/queue");
    expect(c.text).toContain("Hi there,");
    expect(c.subject).toContain("your appointment");
  });
});

describe.skipIf(!reachable)("runDebriefReminders", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb("reminders");
    // withServiceRole() reaches the database through the jobs pool: point it at this test DB.
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
  });
  afterAll(async () => {
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  const jp = async (id: string, over: Record<string, unknown> = {}) => {
    const row = {
      jp_appointment_id: id, title: "ROOF EST: Town/1 Main/Cust", is_sales_type: true, has_result: false, result_option_name: null,
      sales_rep: "Jason Malarchak", crm_lead_id: `L-${id}`, customer_name: `Customer ${id}`, location: "1 Main St",
      starts_at: hoursAgo(3), ...over,
    } as Record<string, unknown>;
    row["appointment_date"] = (row["starts_at"] as Date).toISOString().slice(0, 10);
    const cols = Object.keys(row);
    await db.owner.query(`INSERT INTO jp_appointment (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => row[c]));
  };
  const recipient = (name: string, email: string | null, active = true) =>
    db.owner.query(`INSERT INTO debrief_reminder_recipient (rep_name, email, active) VALUES ($1,$2,$3)`, [name, email, active]);

  beforeEach(async () => {
    await db.owner.query(`TRUNCATE jp_appointment, appointment, debrief, debrief_reminder, debrief_reminder_recipient`);
  });

  it("emails the rep once for a due appointment, and applies every exclusion", async () => {
    await recipient("Jason  Malarchak", "jason@example.com");          // spacing variant on purpose
    await recipient("Pema Sherpa", null);                              // known, no email
    await jp("due");
    await jp("too-recent", { starts_at: hoursAgo(1) });
    await jp("no-see", { has_result: true, result_option_name: "No See" });
    await jp("cancelled", { title: "CANCELLED ROOF EST" });
    await jp("non-sales", { is_sales_type: false, title: "FINAL WALK THROUGH" });
    await jp("no-rep", { sales_rep: null });
    await jp("unknown-rep", { sales_rep: "Somebody New" });
    await jp("no-email-rep", { sales_rep: "Pema Sherpa" });
    await jp("too-old", { starts_at: hoursAgo(24 * 15) });
    await jp("debriefed");
    await db.owner.query(
      `INSERT INTO debrief (submitted_by, customer_name, appointment_date, sales_rep, appointment_setter, appointment_outcome, crm_lead_id, created_by)
       VALUES ('t','x',$1,'Jason','Ashley','Demo Completed — Sale','l-debriefed','t')`, [hoursAgo(3).toISOString().slice(0, 10)]);
    // Debriefed via the JobProgress appointment id only (Lead ID left blank, wrong date typed).
    await jp("debriefed-by-record-id");
    await db.owner.query(
      `INSERT INTO debrief (submitted_by, customer_name, appointment_date, sales_rep, appointment_setter, appointment_outcome, appointment_record_id, created_by)
       VALUES ('t','x','2026-01-01','Jason','Ashley','Demo Completed — Sale','debriefed-by-record-id','t')`);
    // Result form filled (Demo No Sale) but no debrief → still owed.
    await jp("result-no-debrief", { has_result: true, result_option_name: "Demo No Sale" });

    const due = await findDueReminders(NOW, { delayHours: 2, lookbackDays: 14 });
    expect(due.map((d) => d.jp_appointment_id).sort()).toEqual(["due", "no-email-rep", "result-no-debrief", "unknown-rep"]);

    const mailer = fakeMailer();
    const r = await runDebriefReminders({ now: NOW, mailer, startedBy: "test" });
    expect(r).toMatchObject({ status: "completed", due: 4, sent: 2, failed: 0, noRecipient: 2, unmatchedReps: ["Pema Sherpa", "Somebody New"] });
    expect(mailer.sent.map((m) => m.to)).toEqual(["jason@example.com", "jason@example.com"]);
    expect(mailer.sent[0]!.subject).toContain("Customer due");

    // Second run: nothing new to send, the two without recipients are still reported.
    const again = await runDebriefReminders({ now: NOW, mailer, startedBy: "test" });
    expect(again).toMatchObject({ due: 2, sent: 0, noRecipient: 2 });
    expect(mailer.sent).toHaveLength(2);

    const { rows } = await db.owner.query(`SELECT jp_appointment_id, status, recipient_email, sent_by FROM debrief_reminder ORDER BY 1`);
    expect(rows).toEqual([
      { jp_appointment_id: "due", status: "sent", recipient_email: "jason@example.com", sent_by: "test" },
      { jp_appointment_id: "result-no-debrief", status: "sent", recipient_email: "jason@example.com", sent_by: "test" },
    ]);
  });

  it("does not email a rep who has been switched off", async () => {
    await recipient("Jason Malarchak", "jason@example.com", false);
    await jp("due");
    const mailer = fakeMailer();
    const r = await runDebriefReminders({ now: NOW, mailer });
    expect(r).toMatchObject({ due: 1, sent: 0, noRecipient: 1, unmatchedReps: ["Jason Malarchak"] });
  });

  it("records a failed send and retries it on a later run, up to the cap", async () => {
    await recipient("Jason Malarchak", "bounce@example.com");
    await jp("due");
    const failing = fakeMailer({ failFor: "bounce@example.com" });
    for (let i = 0; i < 3; i++) {
      const r = await runDebriefReminders({ now: NOW, mailer: failing });
      expect(r).toMatchObject({ due: 1, sent: 0, failed: 1 });
    }
    // Attempt cap reached: no longer due.
    expect(await runDebriefReminders({ now: NOW, mailer: failing })).toMatchObject({ due: 0 });
    const { rows } = await db.owner.query(`SELECT status, error FROM debrief_reminder`);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ status: "failed", error: "550 mailbox unavailable" });
  });

  it("stays silent in quiet hours and when mail is not configured; dry runs never send", async () => {
    await recipient("Jason Malarchak", "jason@example.com");
    await jp("due");
    const mailer = fakeMailer();
    expect(await runDebriefReminders({ now: new Date("2026-09-09T02:00:00Z"), mailer })).toMatchObject({ status: "quiet_hours", sent: 0 });
    expect(await runDebriefReminders({ now: NOW, mailer: null })).toMatchObject({ status: "not_configured" });
    const dry = await runDebriefReminders({ now: NOW, mailer, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, due: 1, sent: 0 });
    expect(dry.items[0]).toMatchObject({ to: "jason@example.com", outcome: "would send" });
    expect(mailer.sent).toHaveLength(0);
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM debrief_reminder`)).rows[0]!.n).toBe(0);
  });

  it("caps a run and defers the rest to the next one", async () => {
    await recipient("Jason Malarchak", "jason@example.com");
    for (let i = 0; i < 4; i++) await jp(`a${i}`, { starts_at: hoursAgo(3 + i) });
    const mailer = fakeMailer();
    const r = await runDebriefReminders({ now: NOW, mailer, env: { DEBRIEF_REMINDER_PER_RUN_LIMIT: "3" } });
    expect(r).toMatchObject({ due: 4, sent: 3, deferred: 1 });
    expect(await runDebriefReminders({ now: NOW, mailer })).toMatchObject({ due: 1, sent: 1 });
  });

  it("sends a labelled test message and logs it; reports status for the admin page", async () => {
    const mailer = fakeMailer();
    const t = await sendTestReminder("me@example.com", "admin@example.com", mailer);
    expect(t.subject).toMatch(/^\[TEST\] Debrief needed: Sample Customer/);
    expect(mailer.sent[0]!.text).toContain("test of the debrief reminder");
    const { rows } = await db.owner.query(`SELECT status, recipient_email, sent_by FROM debrief_reminder`);
    expect(rows).toEqual([{ status: "test", recipient_email: "me@example.com", sent_by: "admin@example.com" }]);
    await expect(sendTestReminder("me@example.com", "admin", null, {})).rejects.toMatchObject({ statusCode: 501 });

    await jp("due", { sales_rep: "Somebody New" });
    const status = await reminderStatus(null, { SMTP_USER: "n@x.com", SMTP_PASSWORD: "p" });
    expect(status).toMatchObject({ enabled: false, dueNow: 1, dueWithoutRecipient: 1, unmatchedReps: ["Somebody New"], mail: { configured: true } });
    expect(status.repNames[0]).toMatchObject({ rep_name: "Somebody New", appointments: 1 });
    expect(JSON.stringify(status)).not.toContain('"p"');
  });
});
