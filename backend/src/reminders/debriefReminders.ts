/**
 * Debrief reminders.
 *
 * Rule (agreed 2026-09-09): a sales appointment whose start is two hours past,
 * with no debrief filed for it here, earns its rep ONE email. Recipients come
 * from the admin-kept list (debrief_reminder_recipient), keyed by the rep's
 * name as JobProgress spells it — never from login accounts.
 *
 * What is excluded, and why:
 *   - the CRM marked it No See or the title says CANCELLED → nothing to debrief
 *   - a debrief exists (matched on Lead ID + date, the KPI engine's rule),
 *     or the appointment row says Submitted / Approved / Needs Review
 *   - no rep on the appointment yet → skipped this run, picked up once a sync
 *     brings the assignment in (each appointment stays eligible LOOKBACK days)
 *   - the rep has no active recipient with an email → counted and shown on
 *     the admin page, never guessed
 *   - quiet hours (9 PM – 7 AM Eastern) → the run does nothing; the next run
 *     after 7 AM sends
 * A successful send is recorded once per appointment; a failed one is retried
 * on later runs up to MAX_ATTEMPTS.
 */
import { withServiceRole } from "../db/client.js";
import { officeDateTime, OFFICE_TIMEZONE } from "../integrations/jobprogress/time.js";
import { createMailer, mailerConfig, type Mailer } from "./mailer.js";

export const REMINDER_DEFAULT_CRON = "*/15 * * * *";
export const DEFAULT_DELAY_HOURS = 2;
export const DEFAULT_LOOKBACK_DAYS = 14;
export const DEFAULT_PER_RUN_LIMIT = 30;
export const MAX_ATTEMPTS = 3;

export function reminderSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    delayHours: Number(env.DEBRIEF_REMINDER_DELAY_HOURS || DEFAULT_DELAY_HOURS),
    lookbackDays: Number(env.DEBRIEF_REMINDER_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS),
    quietStartHour: Number(env.DEBRIEF_REMINDER_QUIET_START || 21),
    quietEndHour: Number(env.DEBRIEF_REMINDER_QUIET_END || 7),
    perRunLimit: Number(env.DEBRIEF_REMINDER_PER_RUN_LIMIT || DEFAULT_PER_RUN_LIMIT),
    baseUrl: (env.APP_BASE_URL || "https://debrief.alliedroofingusa.com").replace(/\/+$/, ""),
    supportContact: env.DEBRIEF_REMINDER_SUPPORT_CONTACT || "IT / Automation Support",
    cron: env.DEBRIEF_REMINDER_CRON || REMINDER_DEFAULT_CRON,
  };
}

/** Whether the scheduled job should run at all. */
export function reminderSchedule(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; cron: string; reason: string } {
  const { cron } = reminderSettings(env);
  if (env.DEBRIEF_REMINDERS_ENABLED !== "true") return { enabled: false, cron, reason: "DEBRIEF_REMINDERS_ENABLED is not true" };
  const mail = mailerConfig(env);
  if (!mail.configured) return { enabled: false, cron, reason: mail.reason };
  return { enabled: true, cron, reason: "" };
}

/** Office-clock hour of an instant. */
export function officeHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: OFFICE_TIMEZONE, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(now).find((p) => p.type === "hour")!.value);
}

/** 9 PM – 7 AM Eastern by default: no reminder lands on a phone at night. */
export function isQuietHours(now: Date, start = 21, end = 7): boolean {
  const h = officeHour(now);
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

export interface DueReminder {
  jp_appointment_id: string;
  starts_at: Date;
  customer_name: string | null;
  location: string | null;
  title: string | null;
  sales_rep: string;
  crm_lead_id: string | null;
  division: string | null;
  appointment_id: string | null;
  address: string | null;
  city: string | null;
  recipient_email: string | null;
  recipient_active: boolean | null;
}

/** Appointments that owe a reminder right now, with their recipient (if any). */
export async function findDueReminders(now: Date, opts: { delayHours: number; lookbackDays: number }): Promise<DueReminder[]> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<DueReminder>(
      `SELECT ja.jp_appointment_id, ja.starts_at, ja.customer_name, ja.location, ja.title, ja.sales_rep,
              ja.crm_lead_id, ja.division,
              a.id AS appointment_id, a.address, a.city,
              rec.email AS recipient_email, rec.active AS recipient_active
         FROM jp_appointment ja
         LEFT JOIN LATERAL (
           SELECT a.id, a.address, a.city, a.debrief_status FROM appointment a
            WHERE ja.crm_lead_id IS NOT NULL AND a.crm_lead_id IS NOT NULL
              AND allied_norm(a.crm_lead_id) = allied_norm(ja.crm_lead_id)
              AND a.appointment_date = ja.appointment_date
            ORDER BY (a.debrief_status IN ('Submitted','Approved','Needs Review')) DESC, a.created_at
            LIMIT 1) a ON true
         LEFT JOIN debrief_reminder_recipient rec ON rec.rep_key = allied_norm(ja.sales_rep)
        WHERE ja.is_sales_type
          AND ja.starts_at IS NOT NULL
          AND ja.starts_at <= $1::timestamptz - make_interval(hours => $2)
          AND ja.starts_at >= $1::timestamptz - make_interval(days => $3)
          AND coalesce(ja.sales_rep, '') <> ''
          AND NOT (ja.has_result AND coalesce(ja.result_option_name, '') ~* 'no\\s*see|no\\s*show|cancel')
          AND coalesce(ja.title, '') !~* 'cancel'
          AND coalesce(a.debrief_status, 'Missing') IN ('Missing', 'Unmatched')
          -- No debrief by any of the three links: Lead ID + date, the appointment
          -- row, or the JobProgress appointment id (the same rules as the queue).
          AND NOT EXISTS (
            SELECT 1 FROM debrief d
             WHERE (ja.crm_lead_id IS NOT NULL AND d.crm_lead_id IS NOT NULL
                    AND lower(trim(d.crm_lead_id)) = lower(trim(ja.crm_lead_id))
                    AND d.appointment_date = ja.appointment_date)
                OR (a.id IS NOT NULL AND d.appointment_id = a.id)
                OR (d.appointment_record_id IS NOT NULL AND lower(trim(d.appointment_record_id)) = ja.jp_appointment_id))
          AND NOT EXISTS (SELECT 1 FROM debrief_reminder r WHERE r.jp_appointment_id = ja.jp_appointment_id AND r.status = 'sent')
          AND (SELECT count(*) FROM debrief_reminder r WHERE r.jp_appointment_id = ja.jp_appointment_id AND r.status = 'failed') < $4
        ORDER BY ja.starts_at`,
      [now, opts.delayHours, opts.lookbackDays, MAX_ATTEMPTS]);
    return rows;
  }, "reminders:find-due", { quiet: true });
}

/* ── The email ── */

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]!));
const usDate = (d: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d); return m ? `${m[2]}/${m[3]}/${m[1]}` : d; };
const clock = (t: string) => { const [h, m] = t.split(":").map(Number); const hr = h! % 12 === 0 ? 12 : h! % 12; return `${hr}:${String(m).padStart(2, "0")} ${h! >= 12 ? "PM" : "AM"}`; };

export interface ReminderContent { subject: string; text: string; html: string; debriefUrl: string }

export function composeReminder(
  r: Pick<DueReminder, "customer_name" | "location" | "address" | "city" | "starts_at" | "sales_rep" | "appointment_id" | "crm_lead_id" | "division">,
  settings: { baseUrl: string; supportContact: string },
): ReminderContent {
  const { date, time } = officeDateTime(r.starts_at);
  const when = `${usDate(date)} at ${clock(time)}`;
  const customer = r.customer_name || "your appointment";
  const where = r.address || r.location || "";
  const place = [where, r.city].filter(Boolean).join(", ");
  const debriefUrl = r.appointment_id ? `${settings.baseUrl}/submit?appointment_id=${encodeURIComponent(r.appointment_id)}` : `${settings.baseUrl}/queue`;
  const firstName = (r.sales_rep || "").trim().split(/\s+/)[0] || "there";
  const subject = `Debrief needed: ${customer} — ${when}`;

  const text = [
    `Hi ${firstName},`,
    ``,
    `Your appointment with ${customer} on ${when}${place ? ` (${place})` : ""} does not have a debrief yet.`,
    `Please take two minutes to file it:`,
    ``,
    `  ${debriefUrl}`,
    ``,
    `If you do not have access to our platform yet, click the link above and ask ${settings.supportContact} for your account details.`,
    ``,
    r.crm_lead_id ? `Job # ${r.crm_lead_id}${r.division ? ` · ${r.division}` : ""}` : (r.division ?? ""),
    ``,
    `— Allied Roofing Debriefs (automated reminder, sent once per appointment)`,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
    <p style="margin:0 0 16px;font-size:16px">Hi ${esc(firstName)},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5">
      Your appointment with <strong>${esc(customer)}</strong> on <strong>${esc(when)}</strong>${place ? ` (${esc(place)})` : ""}
      does not have a debrief yet. Please take two minutes to file it.
    </p>
    <p style="margin:24px 0;text-align:center">
      <a href="${esc(debriefUrl)}" style="display:inline-block;background:#c2410c;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 28px;border-radius:8px">Submit Debrief</a>
    </p>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#4b5563">
      If you do not have access to our platform yet, click the button above and ask <strong>${esc(settings.supportContact)}</strong> for your account details.
    </p>
    ${r.crm_lead_id || r.division ? `<p style="margin:0 0 16px;font-size:13px;color:#6b7280">${r.crm_lead_id ? `Job # ${esc(r.crm_lead_id)}` : ""}${r.crm_lead_id && r.division ? " · " : ""}${esc(r.division ?? "")}</p>` : ""}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="margin:0;font-size:12px;color:#9ca3af">Allied Roofing Debriefs — automated reminder, sent once per appointment.</p>
  </div></body></html>`;

  return { subject, text, html, debriefUrl };
}

/* ── The run ── */

export interface ReminderRunResult {
  status: "completed" | "quiet_hours" | "not_configured";
  dryRun: boolean;
  due: number;
  sent: number;
  failed: number;
  noRecipient: number;
  deferred: number;
  /** Rep names on due appointments with no active recipient email. */
  unmatchedReps: string[];
  items: { jp_appointment_id: string; customer_name: string | null; sales_rep: string; starts_at: string; to: string | null; outcome: string }[];
}

export async function runDebriefReminders(options: {
  now?: Date; dryRun?: boolean; mailer?: Mailer | null; startedBy?: string; env?: NodeJS.ProcessEnv; ignoreQuietHours?: boolean;
} = {}): Promise<ReminderRunResult> {
  const env = options.env ?? process.env;
  const s = reminderSettings(env);
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const startedBy = options.startedBy ?? "scheduler";
  const base: ReminderRunResult = { status: "completed", dryRun, due: 0, sent: 0, failed: 0, noRecipient: 0, deferred: 0, unmatchedReps: [], items: [] };

  if (!dryRun && !options.ignoreQuietHours && isQuietHours(now, s.quietStartHour, s.quietEndHour)) {
    return { ...base, status: "quiet_hours" };
  }
  const mailer = options.mailer === undefined ? createMailer(env) : options.mailer;
  if (!dryRun && !mailer) return { ...base, status: "not_configured" };

  const due = await findDueReminders(now, s);
  base.due = due.length;
  const unmatched = new Set<string>();
  let budget = s.perRunLimit;

  for (const r of due) {
    const to = r.recipient_active && r.recipient_email ? r.recipient_email : null;
    const item = { jp_appointment_id: r.jp_appointment_id, customer_name: r.customer_name, sales_rep: r.sales_rep, starts_at: r.starts_at.toISOString(), to, outcome: "" };
    if (!to) { base.noRecipient++; unmatched.add(r.sales_rep.trim()); item.outcome = "no recipient"; base.items.push(item); continue; }
    if (budget <= 0) { base.deferred++; item.outcome = "deferred to next run"; base.items.push(item); continue; }
    const content = composeReminder(r, s);
    if (dryRun) { item.outcome = "would send"; base.items.push(item); budget--; continue; }

    budget--;
    let status: "sent" | "failed" = "sent";
    let error: string | null = null;
    try {
      await mailer!.send({ to, subject: content.subject, text: content.text, html: content.html });
    } catch (err) {
      status = "failed";
      error = (err as Error).message.slice(0, 500);
    }
    await withServiceRole(async (c) => {
      await c.query(
        `INSERT INTO debrief_reminder (jp_appointment_id, appointment_id, rep_name, recipient_email, customer_name, starts_at, subject, status, error, sent_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.jp_appointment_id, r.appointment_id, r.sales_rep, to, r.customer_name, r.starts_at, content.subject, status, error, startedBy]);
    }, "reminders:log", { quiet: true });
    if (status === "sent") base.sent++; else base.failed++;
    item.outcome = status === "sent" ? "sent" : `failed: ${error}`;
    base.items.push(item);
  }
  base.unmatchedReps = [...unmatched].sort();
  return base;
}

/** An admin's test message: a realistic sample, clearly labelled, logged as 'test'. */
export async function sendTestReminder(to: string, sentBy: string, mailer: Mailer | null = createMailer(), env = process.env): Promise<{ messageId: string; subject: string }> {
  if (!mailer) throw Object.assign(new Error(`Email is not configured: ${mailerConfig(env).reason}`), { statusCode: 501 });
  const s = reminderSettings(env);
  const sample = composeReminder({
    customer_name: "Sample Customer", location: null, address: "123 Main Street", city: "Wyckoff",
    starts_at: new Date(Date.now() - 2 * 3_600_000), sales_rep: "Sample Rep", appointment_id: null, crm_lead_id: "TEST-0000", division: "ACR Roofing Division",
  }, s);
  const subject = `[TEST] ${sample.subject}`;
  const { messageId } = await mailer.send({ to, subject, text: `This is a test of the debrief reminder email.\n\n${sample.text}`, html: sample.html.replace("Hi Sample,", "Hi — this is a <strong>test</strong> of the debrief reminder email.<br><br>Hi Sample,") });
  await withServiceRole(async (c) => {
    await c.query(
      `INSERT INTO debrief_reminder (jp_appointment_id, rep_name, recipient_email, customer_name, starts_at, subject, status, sent_by)
       VALUES ('test', 'Sample Rep', $1, 'Sample Customer', now(), $2, 'test', $3)`, [to, subject, sentBy]);
  }, "reminders:log-test", { quiet: true });
  return { messageId, subject };
}

export interface ReminderStatus {
  enabled: boolean; cron: string; reason: string;
  mail: { configured: boolean; reason: string; host: string; port: number; user: string; from: string };
  settings: { delayHours: number; lookbackDays: number; quietStartHour: number; quietEndHour: number; perRunLimit: number; baseUrl: string; supportContact: string };
  quietHoursNow: boolean;
  dueNow: number;
  dueWithoutRecipient: number;
  unmatchedReps: string[];
  /** Every rep name seen on CRM sales appointments in the look-back window ×6, with counts, for the recipients page. */
  repNames: { rep_name: string; appointments: number; last_seen: string }[];
  last7Days: { sent: number; failed: number };
  lastRun: { completed_on: string; state: string } | null;
}

export async function reminderStatus(lastRun: ReminderStatus["lastRun"], env = process.env): Promise<ReminderStatus> {
  const s = reminderSettings(env);
  const now = new Date();
  const due = await findDueReminders(now, s);
  const unmatched = [...new Set(due.filter((d) => !(d.recipient_active && d.recipient_email)).map((d) => d.sales_rep.trim()))].sort();
  const { repNames, last7Days } = await withServiceRole(async (c) => {
    const reps = await c.query<{ rep_name: string; appointments: number; last_seen: Date }>(
      `SELECT trim(regexp_replace(sales_rep, '\\s+', ' ', 'g')) AS rep_name, count(*)::int AS appointments, max(starts_at) AS last_seen
         FROM jp_appointment
        WHERE is_sales_type AND coalesce(sales_rep,'') <> '' AND starts_at >= now() - make_interval(days => $1)
        GROUP BY 1 ORDER BY 2 DESC`, [s.lookbackDays * 6]);
    const counts = await c.query<{ sent: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status='sent')::int AS sent, count(*) FILTER (WHERE status='failed')::int AS failed
         FROM debrief_reminder WHERE created_at >= now() - interval '7 days'`);
    return {
      repNames: reps.rows.map((r) => ({ rep_name: r.rep_name, appointments: r.appointments, last_seen: r.last_seen.toISOString() })),
      last7Days: counts.rows[0] ?? { sent: 0, failed: 0 },
    };
  }, "reminders:status", { quiet: true });
  const mail = mailerConfig(env);
  return {
    ...reminderSchedule(env),
    mail: { configured: mail.configured, reason: mail.reason, host: mail.host, port: mail.port, user: mail.user, from: mail.from },
    settings: { delayHours: s.delayHours, lookbackDays: s.lookbackDays, quietStartHour: s.quietStartHour, quietEndHour: s.quietEndHour, perRunLimit: s.perRunLimit, baseUrl: s.baseUrl, supportContact: s.supportContact },
    quietHoursNow: isQuietHours(now, s.quietStartHour, s.quietEndHour),
    dueNow: due.length,
    dueWithoutRecipient: due.filter((d) => !(d.recipient_active && d.recipient_email)).length,
    unmatchedReps: unmatched,
    repNames,
    last7Days,
    lastRun,
  };
}
