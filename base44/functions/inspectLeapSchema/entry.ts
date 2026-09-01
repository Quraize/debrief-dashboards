import { secrets } from "base44:runtime";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.43";

const BASE = "https://api.jobprogress.com/api/v3";

// Compact: return only field names (keys), not values or types
function keysOnly(value, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return "...";
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [keysOnly(value[0], depth + 1, maxDepth)];
  }
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = keysOnly(value[key], depth + 1, maxDepth);
    }
    return result;
  }
  return null;
}

async function fetchJson(url, token) {
  try {
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    });
    if (!res.ok) return { status: res.status, ok: false, body: null };
    const body = await res.json();
    return { status: res.status, ok: true, body };
  } catch (e) {
    return { status: null, ok: false, body: null, error: e.message };
  }
}

function getPaginationTotal(body) {
  const pag = body?.meta?.pagination;
  return pag && typeof pag.total === "number" ? pag.total : null;
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin" && user.role !== "sales_manager") {
      return Response.json({ error: "Forbidden: admin or sales_manager role required" }, { status: 403 });
    }

    const token = secrets.get("LEAP_API_TOKEN");
    if (!token) return Response.json({ error: "LEAP_API_TOKEN not configured" }, { status: 500 });

    const out = {};

    // 1. Documented date filter: duration=date + start_date/end_date with time component
    const daySingle = await fetchJson(`${BASE}/appointments?limit=1&duration=date&start_date=2026-08-01%2000:00:00&end_date=2026-08-01%2023:59:59`, token);
    const rangeFull = await fetchJson(`${BASE}/appointments?limit=1&duration=date&start_date=2026-08-01%2000:00:00&end_date=2026-08-20%2023:59:59`, token);
    out.dateFilterDocumented = {
      single_day_total: getPaginationTotal(daySingle.body),
      range_total: getPaginationTotal(rangeFull.body),
      statuses: { single_day: daySingle.status, range: rangeFull.status },
    };

    // 2. Documented with_job=1 + includes[]=jobs (plural) + result_option + user + attendees + created_by + customer
    const withJobDoc = await fetchJson(`${BASE}/appointments?limit=1&duration=date&start_date=2026-08-01%2000:00:00&end_date=2026-08-20%2023:59:59&with_job=1&includes[]=jobs&includes[]=result_option&includes[]=user&includes[]=attendees&includes[]=created_by&includes[]=customer`, token);
    const wjKeys = withJobDoc.body?.data?.[0] ? Object.keys(withJobDoc.body.data[0]) : [];
    out.withJobDocumented = {
      status: withJobDoc.status,
      total: getPaginationTotal(withJobDoc.body),
      recordKeys: wjKeys,
      jobsShape: withJobDoc.body?.data?.[0]?.jobs ? keysOnly(withJobDoc.body.data[0].jobs, 0, 2) : null,
      jobsIsArray: Array.isArray(withJobDoc.body?.data?.[0]?.jobs),
    };

    // 3. Documented /divisions (not /company/divisions) with includes trades + work_types
    const divisions = await fetchJson(`${BASE}/divisions?limit=100&includes[]=trades&includes[]=work_types`, token);
    out.divisionsDocumented = {
      status: divisions.status,
      total: getPaginationTotal(divisions.body),
      keys: divisions.body?.data?.[0] ? keysOnly(divisions.body.data[0], 0, 2) : null,
    };

    // 4. Get a real job ID from the documented with_job response
    let jobId = withJobDoc.body?.data?.[0]?.jobs?.[0]?.id ?? withJobDoc.body?.data?.[0]?.jobs?.id ?? null;
    if (!jobId) {
      const jobsList = await fetchJson(`${BASE}/jobs?limit=1`, token);
      jobId = jobsList.body?.data?.[0]?.id ?? null;
    }
    out.hasJobId = !!jobId;

    // 5. Documented /jobs with job_ids[] filter + includes
    if (jobId) {
      const jobById = await fetchJson(`${BASE}/jobs?job_ids[]=${jobId}&includes[]=division&includes[]=trades&includes[]=work_types&includes[]=reps&includes[]=estimators&includes[]=financial_details&includes[]=insurance_details&includes[]=custom_fields`, token);
      out.jobsByIdDocumented = {
        status: jobById.status,
        total: getPaginationTotal(jobById.body),
        keys: jobById.body?.data?.[0] ? keysOnly(jobById.body.data[0], 0, 2) : null,
      };

      // 6. Documented financial_summary (underscore)
      const finSum = await fetchJson(`${BASE}/jobs/${jobId}/financial_summary`, token);
      out.financialSummaryUnderscore = {
        status: finSum.status,
        keys: finSum.body?.data ? keysOnly(finSum.body.data, 0, 2) : (finSum.body ? keysOnly(finSum.body, 0, 2) : null),
      };
    }

    return Response.json(out);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}