/**
 * Next Action suggestions: the run against a stubbed Claude, the accept, the
 * managers' instructions, and who may do what.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { hashPassword } from "../src/auth/crypto.js";
import { suggestNextAction } from "../src/integrations/anthropic/nextAction.js";

const reachable = await pgReachable();
requirePg(reachable);

const PASSWORD = "correct horse battery staple";
let db: TestDb;
let app: FastifyInstance;
type Auth = { cookies: Record<string, string>; headers: Record<string, string> };
let prod: Auth, pm: Auth, rep: Auth;

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1) ?? "";
}
async function login(email: string, role: string): Promise<Auth> {
  await db.owner.query(`INSERT INTO app_user (email, full_name, role, password_hash) VALUES ($1, $1, $2, $3)`, [email, role, await hashPassword(PASSWORD)]);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  return { cookies: { allied_session: cookieFrom(res, "allied_session") }, headers: { "x-csrf-token": cookieFrom(res, "allied_csrf") } };
}
async function job(id: string, number: string, stage: string, signed: string, revenue: number | null) {
  await db.owner.query(
    `INSERT INTO jp_job (jp_job_id, jp_customer_id, job_number, current_stage, is_insurance, jp_created_at, contract_signed_date, total_job_revenue, rep_names)
     VALUES ($1, '9001', $2, $3, false, now() - interval '30 days', $4::date, $5, 'Jason Malarchak')`, [id, number, stage, signed, revenue]);
}
async function visit(id: string, jobId: string, code: string, dayEt: string) {
  await db.owner.query(
    `INSERT INTO jp_schedule (jp_schedule_id, jp_job_id, title, job_type_code, start_at, end_at, crew_names)
     VALUES ($1, $2, $3, $3, ($4::timestamp AT TIME ZONE 'America/New_York'), ($4::timestamp AT TIME ZONE 'America/New_York') + interval '6 hours', '{DNC}')`,
    [id, jobId, code, `${dayEt} 08:00`]);
}

/** A Claude that answers from a script keyed by the job number in the facts, and records what it was asked. */
function stubClaude(script: Record<string, unknown | ((facts: Record<string, unknown>) => unknown)>) {
  const calls: { facts: Record<string, unknown>; system: string; model: string }[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; system: { text: string }[]; messages: { content: string }[] };
    const facts = JSON.parse(body.messages[0]!.content.replace(/^JOB FACTS \(JSON\):\n/, "").split("\n\n")[0]!) as Record<string, unknown>;
    calls.push({ facts, system: body.system.map((b) => b.text).join("\n"), model: body.model });
    const scripted = script[String(facts["jobNumber"])];
    const reply = typeof scripted === "function" ? (scripted as (f: Record<string, unknown>) => unknown)(facts) : scripted;
    if (reply === "refuse") return { ok: true, status: 200, json: async () => ({ stop_reason: "refusal", content: [], usage: { input_tokens: 700, output_tokens: 0 } }) } as unknown as Response;
    if (reply === "500") return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
    return {
      ok: true, status: 200,
      json: async () => ({ stop_reason: "end_turn", usage: { input_tokens: 750, output_tokens: 40 }, content: [{ type: "text", text: JSON.stringify(reply ?? { suggestion: "Sales rep does the obvious next thing today.", confidence: "medium" }) }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe.skipIf(!reachable)("Next Action suggestions", () => {
  beforeAll(async () => {
    db = await createTestDb("nextactions");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    process.env.AUTH_LOGIN_RATE_MAX = "10000"; process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    delete process.env.ANTHROPIC_API_KEY;
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
    prod = await login("prod@allied.test", "production");
    pm = await login("pm@allied.test", "project_manager");
    rep = await login("rep@allied.test", "outside_sales_rep");
    await db.owner.query(`INSERT INTO jp_customer (jp_customer_id, customer_name) VALUES ('9001','Lisa Diss')`);
    await job("j1", "2609-0001-01", "Install Accepted-> SUBMIT SS", "2026-09-16", 26749);        // unscheduled → model
    await job("j2", "2607-0002-01", "Accepted/INS Claim Pending", "2026-07-09", null);           // unscheduled, no price → model
    await job("j3", "2609-0003-01", "Approved New Installs", "2026-09-01", 58899);               // scheduled by the calendar → rule only
    await visit("s3", "j3", "RR", "2026-10-06");
    await job("j4", "2608-0004-01", "COMPLETED NEED FINAL PAYMENT!!", "2026-08-01", 12000);      // awaiting payment → model
    await job("j5", "2609-0005-01", "Sales Review", "2026-08-03", 24000);                        // unscheduled, but the team already wrote the next action
    await db.owner.query(`INSERT INTO job_pipeline_note (jp_job_id, next_action, updated_by) VALUES ('j5', 'CEO to review Friday', 'pm@allied.test')`);
  });
  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("the model call is boxed: instructions ahead of facts, one checked sentence back, refusals and failures become null", async () => {
    const { impl, calls } = stubClaude({ "X-1": { suggestion: "Sales rep submits the sold sheet today; sold 7 days ago.", confidence: "high" } });
    const r = await suggestNextAction({ instructions: "Money first.", facts: { jobNumber: "X-1", stage: "s" } }, { apiKey: "k", model: "claude-haiku-4-5", fetchImpl: impl, sleep: async () => {} });
    expect(r).toMatchObject({ suggestion: "Sales rep submits the sold sheet today; sold 7 days ago.", confidence: "high", model: "claude-haiku-4-5", inputTokens: 750, outputTokens: 40, error: null });
    expect(calls[0]!.system).toContain("MANAGER INSTRUCTIONS:\nMoney first.");
    expect(calls[0]!.system.indexOf("Work strictly inside")).toBeLessThan(calls[0]!.system.indexOf("MANAGER INSTRUCTIONS"));
    const refused = stubClaude({ "X-2": "refuse" });
    expect(await suggestNextAction({ instructions: "i", facts: { jobNumber: "X-2" } }, { apiKey: "k", fetchImpl: refused.impl, sleep: async () => {} })).toMatchObject({ suggestion: null, error: "refused", inputTokens: 700 });
    const broken = stubClaude({ "X-3": "500" });
    expect((await suggestNextAction({ instructions: "i", facts: { jobNumber: "X-3" } }, { apiKey: "k", fetchImpl: broken.impl, sleep: async () => {} })).error).toBe("HTTP 500");
    const rambling = stubClaude({ "X-4": { suggestion: "well " + "word ".repeat(40) } });
    expect((await suggestNextAction({ instructions: "i", facts: { jobNumber: "X-4" } }, { apiKey: "k", fetchImpl: rambling.impl, sleep: async () => {} })).error).toMatch(/^unparseable/);
    expect((await suggestNextAction({ instructions: "i", facts: {} }, { fetchImpl: impl })).error).toBe("ANTHROPIC_API_KEY is not set");
  });

  it("runs: rules settle the scheduled job, the model gets the unscheduled and unpaid ones, a person's note is left alone", async () => {
    const { runNextActions } = await import("../src/production/nextActions.js");
    const { impl, calls } = stubClaude({
      "2609-0001-01": { suggestion: "Sales rep submits the sold sheet today; sold 7 days ago.", confidence: "high" },
      "2607-0002-01": (f) => ({ suggestion: f["noContractValue"] ? "Office enters the contract price in JobProgress, then rep calls the adjuster." : "wrong", confidence: "medium" }),
      "2608-0004-01": "refuse",
    });
    const r = await runNextActions({ startedBy: "test", model: { apiKey: "k", model: "claude-haiku-4-5", fetchImpl: impl, sleep: async () => {} } });
    expect(r.status).toBe("completed");
    expect(r.counts).toMatchObject({ rows: 5, humanOwned: 1, unchanged: 0, ruleOnly: 1, suggested: 2, refused: 1, failed: 0, inputTokens: 750 + 750 + 700, outputTokens: 80 });
    expect(r.counts.estimatedCostUsd).toBeCloseTo((2200 * 1 + 80 * 5) / 1_000_000, 6);
    // The model saw the managers' starter instructions and the rule it should sharpen.
    expect(calls.map((c) => c.facts["jobNumber"]).sort()).toEqual(["2607-0002-01", "2608-0004-01", "2609-0001-01"]);
    expect(calls[0]!.system).toContain("Money first");
    const j1 = calls.find((c) => c.facts["jobNumber"] === "2609-0001-01")!.facts;
    expect(j1).toMatchObject({ customer: "Lisa Diss", status: "unscheduled", daysSinceSold: expect.any(Number), rule: { key: "handoff" } });

    const pipe = (await app.inject({ method: "GET", url: "/api/production/pipeline", ...prod })).json();
    const by = Object.fromEntries(pipe.rows.map((x: { jobId: string }) => [x.jobId, x]));
    expect(by["j1"].suggested).toMatchObject({ text: "Sales rep submits the sold sheet today; sold 7 days ago.", confidence: "high", model: "claude-haiku-4-5", ruleKey: "handoff", accepted: false });
    expect(by["j2"].suggested.text).toContain("Office enters the contract price");
    expect(by["j3"].suggested).toMatchObject({ model: "rule", text: "Production confirms crew and materials the week before the 10/6/2026 install." });
    expect(by["j4"].suggested).toMatchObject({ model: "rule-fallback", text: "Office invoices the balance and collects the final payment.", confidence: "medium" });
    expect(by["j5"].suggested).toBeNull(); expect(by["j5"].nextAction).toBe("CEO to review Friday");

    // Second run: nothing changed, nothing is asked again — and it is logged.
    const again = await runNextActions({ startedBy: "test", model: { apiKey: "k", fetchImpl: impl, sleep: async () => {} } });
    expect(again.counts).toMatchObject({ unchanged: 4, suggested: 0, ruleOnly: 0, inputTokens: 0 });
    expect(calls).toHaveLength(3);
    const runs = await db.owner.query(`SELECT status, counts->>'suggested' AS s FROM sync_run WHERE kind = 'next_actions' ORDER BY started_at`);
    expect(runs.rows).toEqual([{ status: "completed", s: "2" }, { status: "completed", s: "0" }]);
    // Force re-asks everything.
    expect((await runNextActions({ startedBy: "test", force: true, model: { apiKey: "k", fetchImpl: impl, sleep: async () => {} } })).counts.suggested).toBe(2);
  });

  it("accepting copies the suggestion into the note and stamps who took it; the instructions are the managers' to change", async () => {
    const acc = await app.inject({ method: "POST", url: "/api/production/pipeline/j1/suggestion/accept", ...prod });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ jobId: "j1", nextAction: "Sales rep submits the sold sheet today; sold 7 days ago.", acceptedBy: "prod@allied.test" });
    const row = (await app.inject({ method: "GET", url: "/api/production/pipeline", ...prod })).json().rows.find((x: { jobId: string }) => x.jobId === "j1");
    expect(row).toMatchObject({ nextAction: "Sales rep submits the sold sheet today; sold 7 days ago.", noteUpdatedBy: "prod@allied.test" });
    expect(row.suggested.accepted).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/production/pipeline/j5/suggestion/accept", ...prod })).statusCode).toBe(404);

    // Instructions: everyone on production reads them, only managers write them, and short ones are refused.
    let ins = (await app.inject({ method: "GET", url: "/api/production/pipeline/instructions", ...prod })).json();
    expect(ins).toMatchObject({ isDefault: true, updatedBy: null }); expect(ins.body).toContain("Money first");
    expect((await app.inject({ method: "POST", url: "/api/production/pipeline/instructions", ...prod, payload: { body: "Insurance jobs first. Always name the rep. Escalate anything over 30 days." } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/production/pipeline/instructions", ...pm, payload: { body: "too short" } })).statusCode).toBe(400);
    const saved = await app.inject({ method: "POST", url: "/api/production/pipeline/instructions", ...pm, payload: { body: "Insurance jobs first. Always name the rep. Escalate anything over 30 days." } });
    expect(saved.statusCode).toBe(200);
    ins = (await app.inject({ method: "GET", url: "/api/production/pipeline/instructions", ...prod })).json();
    expect(ins).toMatchObject({ isDefault: false, updatedBy: "pm@allied.test", body: "Insurance jobs first. Always name the rep. Escalate anything over 30 days." });

    // New instructions change the hash, so the next run asks again with the managers' words.
    const { runNextActions } = await import("../src/production/nextActions.js");
    const { impl, calls } = stubClaude({});
    const r = await runNextActions({ startedBy: "test", model: { apiKey: "k", fetchImpl: impl, sleep: async () => {} } });
    expect(r.counts.humanOwned).toBe(2);              // j1 is now the team's too
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.system).toContain("Insurance jobs first.");
  });

  it("status reports the schedule and the last run; a sales rep and an anonymous caller are refused", async () => {
    const st = (await app.inject({ method: "GET", url: "/api/production/pipeline/next-actions", ...prod })).json();
    expect(st).toMatchObject({ enabled: false, reason: "ANTHROPIC_API_KEY not set", model: "claude-haiku-4-5" });
    expect(st.lastRun).toMatchObject({ status: "completed", startedBy: "test" });
    // Without a key the run refuses cleanly and says why, logged as failed.
    const noKey = await app.inject({ method: "POST", url: "/api/production/pipeline/next-actions/run", ...prod, payload: {} });
    expect(noKey.statusCode).toBe(502); expect(noKey.json().detail).toBe("ANTHROPIC_API_KEY not set");
    for (const url of ["/api/production/pipeline/next-actions", "/api/production/pipeline/instructions"]) {
      expect((await app.inject({ method: "GET", url, ...rep })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: "/api/production/pipeline/j1/suggestion/accept", ...rep })).statusCode).toBe(403);
  });
});
