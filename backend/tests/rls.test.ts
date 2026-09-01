/**
 * Row-Level Security policy tests.
 *
 * Authorization is a feature; these test it like one (MIGRATION_PLAN.md §8.3).
 * They run against a real PostgreSQL created from the real migrations - mocking
 * the database here would test nothing, since the policies ARE the behaviour.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { createTestDb, pgReachable, requirePg, asUser, expectDenied, type TestDb } from "./helpers/db.js";

const reachable = await pgReachable();
requirePg(reachable);

const REP_A = { email: "rep.a@allied.test", role: "outside_sales_rep" };
const REP_B = { email: "rep.b@allied.test", role: "outside_sales_rep" };
const MANAGER = { email: "manager@allied.test", role: "sales_manager" };
const ADMIN = { email: "admin@allied.test", role: "admin" };
const VIEWER = { email: "viewer@allied.test", role: "view_only" };

let db: TestDb;
let repADebriefId: string;

const insertDebrief = (c: pg.PoolClient, customer: string) =>
  c.query<{ id: string }>(
    `INSERT INTO debrief (customer_name, appointment_date, sales_rep, appointment_setter,
                          appointment_outcome, submitted_by)
     VALUES ($1, '2026-07-15', 'Rep A', 'Setter A', 'Demo Completed — Sale', 'Rep A')
     RETURNING id`,
    [customer],
  );

describe.skipIf(!reachable)("RLS policies", () => {
  beforeAll(async () => {
    db = await createTestDb("rls");
    // Rep A files a debrief; created_by is populated from the session context.
    repADebriefId = await asUser(db.app, REP_A.email, REP_A.role, async (c) => {
      const { rows } = await insertDebrief(c, "Customer One");
      return rows[0]!.id;
    });
  });
  afterAll(async () => db?.drop());

  describe("no anonymous access", () => {
    it("refuses every table when no identity is set on the session", async () => {
      const c = await db.app.connect();
      try {
        for (const t of ["appointment", "debrief", "list_option", "sync_run", "app_user"]) {
          const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${t}`);
          // RLS returns zero rows rather than raising - the practical equivalent
          // of "invisible", and the reason an unset role must never be treated
          // as a trusted default anywhere in the backend.
          expect(rows[0].n, `${t} must be invisible without an identity`).toBe(0);
        }
      } finally {
        c.release();
      }
    });

    it("refuses writes when no identity is set", async () => {
      const c = await db.app.connect();
      try {
        const err = await expectDenied(insertDebrief(c, "Anonymous Customer"));
        expect(err.message).toMatch(/row-level security/i);
      } finally {
        c.release();
      }
    });
  });

  describe("read-all (D2)", () => {
    it("lets any signed-in role read every debrief, so dashboards still aggregate", async () => {
      for (const u of [REP_B, VIEWER, MANAGER, ADMIN]) {
        const n = await asUser(db.app, u.email, u.role, async (c) =>
          (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM debrief")).rows[0]!.n,
        );
        expect(n, `${u.role} should see all debriefs`).toBeGreaterThan(0);
      }
    });
  });

  describe("write-own (D2)", () => {
    it("lets the author edit their own debrief", async () => {
      const n = await asUser(db.app, REP_A.email, REP_A.role, async (c) =>
        (await c.query("UPDATE debrief SET notes = 'mine' WHERE id = $1", [repADebriefId])).rowCount,
      );
      expect(n).toBe(1);
    });

    it("does NOT let another rep edit it", async () => {
      // The row is filtered out by the USING clause, so the UPDATE silently
      // matches nothing. Zero rows affected IS the denial.
      const n = await asUser(db.app, REP_B.email, REP_B.role, async (c) =>
        (await c.query("UPDATE debrief SET notes = 'tampered' WHERE id = $1", [repADebriefId])).rowCount,
      );
      expect(n).toBe(0);
    });

    it("leaves the value untouched after the refused write", async () => {
      const notes = await asUser(db.app, ADMIN.email, ADMIN.role, async (c) =>
        (await c.query<{ notes: string }>("SELECT notes FROM debrief WHERE id = $1", [repADebriefId]))
          .rows[0]!.notes,
      );
      expect(notes).toBe("mine");
    });

    it("lets a manager edit anyone's debrief", async () => {
      const n = await asUser(db.app, MANAGER.email, MANAGER.role, async (c) =>
        (await c.query("UPDATE debrief SET notes = 'reviewed' WHERE id = $1", [repADebriefId])).rowCount,
      );
      expect(n).toBe(1);
    });

    it("does not let a rep delete a debrief", async () => {
      const n = await asUser(db.app, REP_A.email, REP_A.role, async (c) =>
        (await c.query("DELETE FROM debrief WHERE id = $1", [repADebriefId])).rowCount,
      );
      expect(n).toBe(0);
    });
  });

  describe("privilege escalation", () => {
    it("refuses to let the request path write app_user.role at all", async () => {
      await asUser(db.jobs, ADMIN.email, ADMIN.role, (c) =>
        c.query(`INSERT INTO app_user (email, role) VALUES ($1, 'outside_sales_rep')`, [REP_A.email]),
      );
      const err = await expectDenied(
        asUser(db.app, REP_A.email, REP_A.role, (c) =>
          c.query(`UPDATE app_user SET role = 'admin' WHERE email = $1`, [REP_A.email]),
        ),
      );
      // Refused by the grant system, before any policy is consulted.
      expect(err.message).toMatch(/permission denied|column "role"/i);
    });

    it("still allows a user to update their own harmless fields", async () => {
      const n = await asUser(db.app, REP_A.email, REP_A.role, async (c) =>
        (await c.query(`UPDATE app_user SET phone = '555-0100' WHERE email = $1`, [REP_A.email])).rowCount,
      );
      expect(n).toBe(1);
    });

    it("keeps one user's app_user row invisible to another", async () => {
      const n = await asUser(db.app, REP_B.email, REP_B.role, async (c) =>
        (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM app_user")).rows[0]!.n,
      );
      expect(n).toBe(0);
    });
  });

  describe("operational tables are admin-only", () => {
    it.each(["sync_run", "sync_conflict", "marketing_source", "appointment_import_exclusion"])(
      "%s is invisible to a rep", async (table) => {
        const n = await asUser(db.app, REP_A.email, REP_A.role, async (c) =>
          (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n,
        );
        expect(n).toBe(0);
      });

    it("lets an admin write a sync run", async () => {
      const n = await asUser(db.app, ADMIN.email, ADMIN.role, async (c) =>
        (await c.query(
          `INSERT INTO sync_run (mode, status, date_from, date_to) VALUES ('dry_run','running','2026-07-01','2026-07-31')`,
        )).rowCount,
      );
      expect(n).toBe(1);
    });

    it("refuses a sales_manager writing a sync run", async () => {
      const err = await expectDenied(
        asUser(db.app, MANAGER.email, MANAGER.role, (c) =>
          c.query(`INSERT INTO sync_run (mode, status, date_from, date_to)
                   VALUES ('commit','running','2026-07-01','2026-07-31')`),
        ),
      );
      expect(err.message).toMatch(/row-level security/i);
    });
  });

  describe("appointment policies", () => {
    it("lets a rep update debrief_status (the submit flow depends on it)", async () => {
      const id = await asUser(db.app, MANAGER.email, MANAGER.role, async (c) =>
        (await c.query<{ id: string }>(
          `INSERT INTO appointment (customer_name, appointment_date) VALUES ('Cust','2026-07-15') RETURNING id`,
        )).rows[0]!.id,
      );
      const n = await asUser(db.app, REP_A.email, REP_A.role, async (c) =>
        (await c.query(`UPDATE appointment SET debrief_status='Submitted' WHERE id=$1`, [id])).rowCount,
      );
      expect(n).toBe(1);
    });

    it("does not let a rep create an appointment", async () => {
      const err = await expectDenied(
        asUser(db.app, REP_A.email, REP_A.role, (c) =>
          c.query(`INSERT INTO appointment (customer_name) VALUES ('Sneaky')`),
        ),
      );
      expect(err.message).toMatch(/row-level security/i);
    });
  });

  describe("allied_jobs bypasses RLS deliberately", () => {
    it("sees every row regardless of identity, for sync and import", async () => {
      const c = await db.jobs.connect();
      try {
        const { rows } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM debrief");
        expect(rows[0]!.n).toBeGreaterThan(0);
      } finally {
        c.release();
      }
    });
  });
});
