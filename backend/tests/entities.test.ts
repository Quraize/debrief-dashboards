/**
 * Entity API contract and security tests (MIGRATION_PLAN.md §8.4).
 *
 * This API's shape is load-bearing for 31 frontend files and 84 call sites, and
 * it is generic, which means the allowlist in registry.ts is the only thing
 * standing between a query string and the database. Both properties are tested
 * here: the contract the shim depends on, and the boundaries it must not cross.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { hashPassword } from "../src/auth/crypto.js";

const reachable = await pgReachable();
requirePg(reachable);

const PASSWORD = "correct horse battery staple";
const ADMIN = "admin@allied.test";
const REP_A = "rep.a@allied.test";
const REP_B = "rep.b@allied.test";

let db: TestDb;
let app: FastifyInstance;
const sessions = new Map<string, { cookie: string; csrf: string }>();

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1) ?? "";
}

const as = (email: string) => {
  const s = sessions.get(email)!;
  return { cookies: { allied_session: s.cookie }, headers: { "x-csrf-token": s.csrf } };
};

async function seedUser(email: string, role: string) {
  await db.owner.query(
    `INSERT INTO app_user (email, full_name, role, password_hash)
     VALUES ($1, $1, $2, $3) ON CONFLICT (email) DO NOTHING`,
    [email, role, await hashPassword(PASSWORD)],
  );
  const res = await app.inject({
    method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD },
  });
  sessions.set(email, {
    cookie: cookieFrom(res, "allied_session"),
    csrf: cookieFrom(res, "allied_csrf"),
  });
}

describe.skipIf(!reachable)("entity API", () => {
  beforeAll(async () => {
    db = await createTestDb("entities");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    process.env.AUTH_LOGIN_RATE_MAX = "10000";
    process.env.RATE_LIMIT_GLOBAL_MAX = "10000";

    const { buildApp } = await import("../src/app.js");
    app = await buildApp();

    await seedUser(ADMIN, "admin");
    await seedUser(REP_A, "outside_sales_rep");
    await seedUser(REP_B, "outside_sales_rep");

    // 25 appointments so pagination has something to page through.
    for (let i = 1; i <= 25; i++) {
      await db.owner.query(
        `INSERT INTO appointment (customer_name, crm_lead_id, appointment_date, appointment_time, created_at)
         VALUES ($1, $2, $3::date, $4, now() - ($5 || ' minutes')::interval)`,
        [`Customer ${i}`, `L-${i}`, "2026-07-01", `0${(i % 9) + 1}:00`, String(i)],
      );
    }
    await db.owner.query(
      `INSERT INTO list_option (category, value) VALUES
        ('sales_rep','Jason'), ('sales_rep','Pema'), ('appointment_setter','Ashley')`);
  });

  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  describe("the contract the shim depends on", () => {
    it("returns { data, meta } with a usable total and hasMore", async () => {
      const res = await app.inject({
        method: "GET", url: "/api/entities/Appointment?limit=10", ...as(ADMIN) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(10);
      expect(body.meta).toMatchObject({ total: 25, limit: 10, offset: 0, hasMore: true });
    });

    it("honours Base44-style descending sort", async () => {
      const res = await app.inject({
        method: "GET", url: "/api/entities/Appointment?sort=-created_date&limit=25", ...as(ADMIN) });
      const dates = res.json().data.map((r: { created_at: string }) => r.created_at);
      const sorted = [...dates].sort().reverse();
      expect(dates).toEqual(sorted);
    });

    it("exposes the legacy created_date alias the UI still reads", async () => {
      const row = (await app.inject({
        method: "GET", url: "/api/entities/Appointment?limit=1", ...as(ADMIN) })).json().data[0];
      expect(row.created_date).toBeDefined();
      expect(row.created_date).toBe(row.created_at);
    });

    it("returns a SQL date as a plain YYYY-MM-DD string, never a shifted timestamp", async () => {
      // node-postgres parses `date` into a JS Date at LOCAL midnight, which
      // moves the value across the UTC boundary: on a UTC+5 machine 2026-07-01
      // serialises as 2026-06-30T19:00:00.000Z — the wrong day, and the wrong
      // MONTH on the first of one.
      //
      // It fails silently, which is what makes it dangerous: inDateRange() does
      // `new Date(value + "T00:00:00")`, an ISO string makes that Invalid Date,
      // and the row is dropped from the aggregate rather than counted wrongly.
      // Every date-driven KPI would simply read low.
      const res = await app.inject({
        method: "GET", url: "/api/entities/Appointment?limit=5", ...as(ADMIN) });
      for (const row of res.json().data) {
        expect(row.appointment_date, "appointment_date must be a bare calendar date")
          .toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it("still returns timestamptz as a real instant", async () => {
      // The opposite of the above: a timestamptz genuinely carries a timezone,
      // so an ISO instant is the correct representation.
      const row = (await app.inject({
        method: "GET", url: "/api/entities/Appointment?limit=1", ...as(ADMIN) })).json().data[0];
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    });

    it("round-trips a date through a write without shifting it", async () => {
      const created = (await app.inject({
        method: "POST", url: "/api/entities/Appointment", ...as(ADMIN),
        payload: {
          customer_name: "Date Roundtrip", crm_lead_id: "DATE-1",
          appointment_date: "2026-01-01", appointment_time: "00:30",
        },
      })).json().data;
      // New Year's Day is the worst case: a backwards shift changes the year.
      expect(created.appointment_date).toBe("2026-01-01");
    });

    it("filters by equality, the only form any call site uses", async () => {
      const res = await app.inject({
        method: "GET", url: "/api/entities/ListOption?category=sales_rep", ...as(ADMIN) });
      const rows = res.json().data;
      expect(rows).toHaveLength(2);
      expect(rows.every((r: { category: string }) => r.category === "sales_rep")).toBe(true);
    });

    it("pages without duplicating or skipping rows", async () => {
      // Most appointments here share a date, so without the id tiebreaker in
      // the ORDER BY, rows could swap between pages and be returned twice.
      //
      // The expected count is read from meta.total rather than hardcoded: other
      // tests in this file legitimately insert rows, and a fixed number would
      // make this fail for a reason that has nothing to do with pagination.
      const first = await app.inject({
        method: "GET", url: "/api/entities/Appointment?limit=1", ...as(ADMIN) });
      const total = first.json().meta.total as number;

      const seen: string[] = [];
      for (let offset = 0; offset < total; offset += 7) {
        const res = await app.inject({
          method: "GET",
          url: `/api/entities/Appointment?sort=-appointment_date&limit=7&offset=${offset}`,
          ...as(ADMIN),
        });
        seen.push(...res.json().data.map((r: { id: string }) => r.id));
      }
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size, "no row should appear on two pages").toBe(total);
    });

    it("caps page size rather than trusting the client", async () => {
      const res = await app.inject({
        method: "GET", url: "/api/entities/Appointment?limit=999999", ...as(ADMIN) });
      expect(res.json().meta.limit).toBeLessThanOrEqual(1000);
    });
  });

  describe("input is rejected, not silently ignored", () => {
    it("rejects an unknown sort field", async () => {
      // Silently falling back to a default would mean a dashboard sorted by the
      // wrong column with no indication anything went wrong.
      const res = await app.inject({
        method: "GET", url: "/api/entities/Appointment?sort=-not_a_column", ...as(ADMIN) });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown filter field", async () => {
      const res = await app.inject({
        method: "GET", url: "/api/entities/Appointment?nonsense=1", ...as(ADMIN) });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown entity", async () => {
      const res = await app.inject({
        method: "GET", url: "/api/entities/NotAThing", ...as(ADMIN) });
      expect(res.statusCode).toBe(404);
    });

    it.each([
      "id; DROP TABLE appointment",
      "id) --",
      '"; DELETE FROM debrief; --',
      "created_at, (SELECT password_hash FROM app_user)",
    ])("refuses injection through the sort parameter: %s", async (payload) => {
      const res = await app.inject({
        method: "GET",
        url: `/api/entities/Appointment?sort=${encodeURIComponent(payload)}`,
        ...as(ADMIN),
      });
      expect(res.statusCode).toBe(400);
      // And the table is still there.
      const check = await app.inject({
        method: "GET", url: "/api/entities/Appointment?limit=1", ...as(ADMIN) });
      expect(check.statusCode).toBe(200);
    });

    it("refuses injection through a filter key", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/entities/Appointment?${encodeURIComponent("id=1 OR 1=1")}=x`,
        ...as(ADMIN),
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("authorization", () => {
    it("refuses every entity route without a session", async () => {
      for (const url of ["/api/entities/Appointment", "/api/entities/Debrief", "/api/entities/ListOption"]) {
        expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      }
    });

    it("hides admin-only entities from a rep", async () => {
      for (const e of ["SyncRun", "SyncConflict", "MarketingSource"]) {
        const res = await app.inject({ method: "GET", url: `/api/entities/${e}`, ...as(REP_A) });
        expect(res.statusCode, e).toBe(403);
      }
    });

    it("lets an admin read them", async () => {
      const res = await app.inject({ method: "GET", url: "/api/entities/SyncRun", ...as(ADMIN) });
      expect(res.statusCode).toBe(200);
    });

    it("does not let a rep create an appointment", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/entities/Appointment",
        payload: { customer_name: "Sneaky" }, ...as(REP_A),
      });
      expect(res.statusCode).toBe(403);
    });

    it("does not expose account creation through the entity API", async () => {
      // Exposing this would rebuild the registration surface Sprint 2 removed.
      const res = await app.inject({
        method: "POST", url: "/api/entities/User",
        payload: { email: "intruder@allied.test", role: "admin" }, ...as(ADMIN),
      });
      expect(res.statusCode).toBe(405);
    });

    it("never returns a password hash or TOTP secret", async () => {
      const res = await app.inject({ method: "GET", url: "/api/entities/User", ...as(ADMIN) });
      const body = JSON.stringify(res.json());
      expect(body).not.toContain("$argon2");
      expect(body).not.toContain("password_hash");
      expect(body).not.toContain("totp_secret");
    });
  });

  describe("RLS still applies underneath the API", () => {
    let repADebriefId: string;

    it("creates a debrief attributed to its author", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/entities/Debrief", ...as(REP_A),
        payload: {
          customer_name: "Client One", appointment_date: "2026-07-15",
          sales_rep: "Rep A", appointment_setter: "Setter A",
          appointment_outcome: "Demo Completed — Sale", submitted_by: "Rep A",
          sale_amount: 12500.5,
        },
      });
      expect(res.statusCode).toBe(201);
      repADebriefId = res.json().data.id;
      expect(res.json().data.created_by).toBe(REP_A);
    });

    it("lets the author edit their own debrief", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/entities/Debrief/${repADebriefId}`,
        payload: { notes: "mine" }, ...as(REP_A),
      });
      expect(res.statusCode).toBe(200);
    });

    it("gives another rep a 404, not a 403, for a row they may not edit", async () => {
      // RLS filters the row out, so the UPDATE matches nothing. 404 is the right
      // answer: a 403 would confirm the row exists to someone not allowed to see it.
      const res = await app.inject({
        method: "PATCH", url: `/api/entities/Debrief/${repADebriefId}`,
        payload: { notes: "tampered" }, ...as(REP_B),
      });
      expect(res.statusCode).toBe(404);
    });

    it("leaves the value untouched after the refused write", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/entities/Debrief/${repADebriefId}`, ...as(ADMIN) });
      expect(res.json().data.notes).toBe("mine");
    });

    it("lets a manager edit anyone's debrief", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/entities/Debrief/${repADebriefId}`,
        payload: { notes: "reviewed" }, ...as(ADMIN),
      });
      expect(res.statusCode).toBe(200);
    });

    it("keeps money exact through the API", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/entities/Debrief/${repADebriefId}`, ...as(ADMIN) });
      // numeric stays a string end to end; 12500.50 must not become 12500.5000001
      expect(res.json().data.sale_amount).toBe("12500.50");
    });
  });

  describe("writes", () => {
    it("requires a CSRF token", async () => {
      const s = sessions.get(ADMIN)!;
      const res = await app.inject({
        method: "POST", url: "/api/entities/ListOption",
        payload: { category: "sales_rep", value: "NoCsrf" },
        cookies: { allied_session: s.cookie },
      });
      expect(res.statusCode).toBe(403);
    });

    it("treats PATCH as partial, not a replacement", async () => {
      const created = (await app.inject({
        method: "POST", url: "/api/entities/ListOption",
        payload: { category: "sales_rep", value: "Partial" }, ...as(ADMIN),
      })).json().data;

      const patched = (await app.inject({
        method: "PATCH", url: `/api/entities/ListOption/${created.id}`,
        payload: { value: "Renamed" }, ...as(ADMIN),
      })).json().data;

      expect(patched.value).toBe("Renamed");
      expect(patched.category, "an omitted field must not be blanked").toBe("sales_rep");
    });

    it("discards unknown fields instead of failing the write", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/entities/ListOption",
        payload: { category: "sales_rep", value: "Extra", not_a_column: "x" }, ...as(ADMIN),
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.value).toBe("Extra");
    });

    it("refuses to write a generated column", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/entities/Appointment", ...as(ADMIN),
        payload: {
          customer_name: "Generated", crm_lead_id: "GEN-1",
          appointment_date: "2026-08-01", appointment_time: "10:00",
          identity_key: "forged|value|here",
        },
      });
      expect(res.statusCode).toBe(201);
      // The database computed it; the client's value was ignored.
      expect(res.json().data.identity_key).toBe("gen-1|2026-08-01|10:00");
    });

    it("turns empty strings into NULL for typed columns", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/entities/Appointment", ...as(ADMIN),
        payload: {
          customer_name: "Blank Dates", crm_lead_id: "BLANK-1",
          appointment_date: "2026-08-02", appointment_time: "10:00",
          sale_date: "", demo_date: "",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.sale_date).toBeNull();
    });

    it("surfaces the identity constraint as a real error", async () => {
      const payload = {
        customer_name: "Dup", crm_lead_id: "DUP-1",
        appointment_date: "2026-08-03", appointment_time: "10:00",
      };
      expect((await app.inject({
        method: "POST", url: "/api/entities/Appointment", payload, ...as(ADMIN) })).statusCode).toBe(201);
      const second = await app.inject({
        method: "POST", url: "/api/entities/Appointment", payload, ...as(ADMIN) });
      expect(second.statusCode).toBeGreaterThanOrEqual(400);
    });

    it("deletes and then reports the row as gone", async () => {
      const created = (await app.inject({
        method: "POST", url: "/api/entities/ListOption",
        payload: { category: "sales_rep", value: "Doomed" }, ...as(ADMIN),
      })).json().data;

      expect((await app.inject({
        method: "DELETE", url: `/api/entities/ListOption/${created.id}`, ...as(ADMIN) })).statusCode).toBe(200);
      expect((await app.inject({
        method: "DELETE", url: `/api/entities/ListOption/${created.id}`, ...as(ADMIN) })).statusCode).toBe(404);
    });
  });

  describe("the JobProgress mirror is readable by all, writable by none", () => {
    beforeAll(async () => {
      await db.owner.query(
        `INSERT INTO jp_appointment (jp_appointment_id, title, appointment_date, is_sales_type, two_leg_answer)
         VALUES ('9001', 'ROOF EST', '2026-08-10', true, 'two_leg')`);
      await db.owner.query(
        `INSERT INTO jp_job (jp_job_id, job_number, contract_signed_date, total_job_revenue)
         VALUES ('9501', 'L-9501', '2026-08-15', 32990)`);
    });

    it("lets a rep read both mirror entities — dashboards are not admin-only", async () => {
      const appts = await app.inject({ method: "GET", url: "/api/entities/JPAppointment", ...as(REP_A) });
      expect(appts.statusCode).toBe(200);
      expect(appts.json().data[0]).toMatchObject({ jp_appointment_id: "9001", two_leg_answer: "two_leg" });

      const jobs = await app.inject({ method: "GET", url: "/api/entities/JPJob", ...as(REP_A) });
      expect(jobs.statusCode).toBe(200);
      // NUMERIC arrives as a string by design — the type parser refuses floats.
      expect(jobs.json().data[0]).toMatchObject({ jp_job_id: "9501", total_job_revenue: "32990.00" });
    });

    it("rejects unauthenticated reads", async () => {
      expect((await app.inject({ method: "GET", url: "/api/entities/JPAppointment" })).statusCode).toBe(401);
    });

    it("refuses writes for everyone, admin included — the mirror must never be forgeable", async () => {
      for (const [method, url] of [
        ["POST", "/api/entities/JPAppointment"],
        ["PATCH", "/api/entities/JPAppointment/some-id"],
        ["DELETE", "/api/entities/JPAppointment/some-id"],
        ["POST", "/api/entities/JPJob"],
      ] as const) {
        const res = await app.inject({
          method, url, ...(method === "POST" || method === "PATCH" ? { payload: { title: "forged" } } : {}),
          ...as(ADMIN),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(405);
      }
    });
  });
});
