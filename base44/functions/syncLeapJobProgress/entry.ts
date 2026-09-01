import { secrets } from "base44:runtime";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.43";

const BASE = "https://api.jobprogress.com/api/v3";
const CALL_DELAY_MS = 200;
const MAX_RETRIES = 3;
const MAX_APPT_PAGES = 60;     // safety cap (6000 appointments)
const JOB_BATCH_SIZE = 20;     // job_ids[] per request (URL length safety)
const MAX_JOB_BATCHES = 30;    // safety cap

// ─── Rate-limited API client ───
let lastCallTime = 0;
const stats = { rateLimitHits: 0, retries: 0, errors: [] };
const endpointStatuses = {};

async function apiFetch(url, token, label, retryCount = 0) {
  const now = Date.now();
  const wait = Math.max(0, lastCallTime + CALL_DELAY_MS - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallTime = Date.now();

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!endpointStatuses[label]) endpointStatuses[label] = { status: res.status, hits: 0 };
    endpointStatuses[label].hits++;

    if (res.status === 429 && retryCount < MAX_RETRIES) {
      stats.rateLimitHits++;
      endpointStatuses[label].status = 429;
      const backoff = Math.pow(2, retryCount) * 1000;
      await new Promise((r) => setTimeout(r, backoff));
      return apiFetch(url, token, label, retryCount + 1);
    }
    if (res.status >= 500 && retryCount < 2) {
      stats.retries++;
      await new Promise((r) => setTimeout(r, 1000));
      return apiFetch(url, token, label, retryCount + 1);
    }
    return res;
  } catch (e) {
    if (retryCount < MAX_RETRIES) {
      stats.retries++;
      await new Promise((r) => setTimeout(r, 500));
      return apiFetch(url, token, label, retryCount + 1);
    }
    stats.errors.push(`${label}: ${e.message}`);
    return null;
  }
}

// ─── Divisions: GET /divisions?limit=100&includes[]=trades&includes[]=work_types ───
async function fetchDivisions(token) {
  const url = `${BASE}/divisions?limit=100&includes[]=trades&includes[]=work_types`;
  const res = await apiFetch(url, token, "divisions");
  if (!res || !res.ok) return { map: {}, status: res ? res.status : "no_response" };
  const body = await res.json();
  const data = body.data || [];
  const map = {};
  for (const d of data) {
    if (d.id != null) map[String(d.id)] = { name: d.name || "", trades: d.trades || [], work_types: d.work_types || [] };
  }
  return { map, status: res.status, count: data.length };
}

// ─── Appointments: GET /appointments?duration=date&start_date=...&end_date=...&with_job=1&includes[]=... ───
async function fetchAppointments(token, dateFrom, dateTo) {
  const startEnc = encodeURIComponent(`${dateFrom} 00:00:00`);
  const endEnc = encodeURIComponent(`${dateTo} 23:59:59`);
  const includeParams = "includes[]=jobs&includes[]=result_option&includes[]=user&includes[]=attendees&includes[]=created_by&includes[]=customer";

  const all = [];
  const seenIds = new Set();
  let totalPages = 1;
  let totalExamined = 0;
  let firstStatus = null;

  for (let page = 1; page <= MAX_APPT_PAGES; page++) {
    const url = `${BASE}/appointments?duration=date&start_date=${startEnc}&end_date=${endEnc}&with_job=1&limit=100&page=${page}&${includeParams}`;
    const res = await apiFetch(url, token, "appointments");
    if (!res || !res.ok) {
      if (res) stats.errors.push(`appointments_page_${page}: HTTP ${res.status}`);
      break;
    }
    if (firstStatus === null) firstStatus = res.status;
    const body = await res.json();
    if (page === 1) totalPages = body.meta?.pagination?.total_pages || 1;
    const data = body.data || [];
    totalExamined += data.length;
    for (const a of data) {
      if (!seenIds.has(a.id)) {
        seenIds.add(a.id);
        all.push(a);
      }
    }
    if (page >= totalPages) break;
  }

  return { appts: all, totalExamined, totalPages, firstStatus };
}

// ─── Extract included jobs from appointments (jobs.data array per appointment) ───
function extractIncludedJobs(appts) {
  const jobMap = {};       // number → job (from included data)
  const jobIdMap = {};     // id → job
  const seenJobIds = new Set();
  for (const a of appts) {
    const jobs = a.jobs;
    if (!jobs) continue;
    const jobList = Array.isArray(jobs.data) ? jobs.data : (Array.isArray(jobs) ? jobs : []);
    for (const j of jobList) {
      if (j && j.id != null && !seenJobIds.has(j.id)) {
        seenJobIds.add(j.id);
        jobIdMap[j.id] = j;
        if (j.number) jobMap[j.number] = j;
      }
    }
  }
  return { jobMap, jobIdMap, uniqueJobIds: Array.from(seenJobIds) };
}

// ─── Fetch full job details by job_ids[] batches ───
async function fetchJobsByIds(token, jobIds) {
  const includeParams = "includes[]=division&includes[]=trades&includes[]=work_types&includes[]=reps&includes[]=estimators&includes[]=financial_details&includes[]=insurance_details&includes[]=custom_fields";
  const detailMap = {};   // id → full job
  let batches = 0;
  let status = null;
  let totalFetched = 0;

  for (let i = 0; i < jobIds.length && batches < MAX_JOB_BATCHES; i += JOB_BATCH_SIZE, batches++) {
    const batch = jobIds.slice(i, i + JOB_BATCH_SIZE);
    const idsParam = batch.map((id) => `job_ids[]=${id}`).join("&");
    const url = `${BASE}/jobs?${idsParam}&${includeParams}`;
    const res = await apiFetch(url, token, "jobs_by_ids");
    if (!res || !res.ok) {
      if (res) stats.errors.push(`jobs_batch_${batches}: HTTP ${res.status}`);
      continue;
    }
    if (status === null) status = res.status;
    const body = await res.json();
    const data = body.data || [];
    totalFetched += data.length;
    for (const j of data) {
      if (j && j.id != null) detailMap[j.id] = j;
    }
  }
  return { detailMap, status, batches, totalFetched };
}

// ─── Financial summary: GET /jobs/{id}/financial_summary (underscore) ───
async function fetchFinancialSummary(token, jobId) {
  const res = await apiFetch(`${BASE}/jobs/${jobId}/financial_summary`, token, "financial_summary");
  if (!res || !res.ok) return { status: res ? res.status : "no_response", record: null };
  const body = await res.json();
  const arr = Array.isArray(body.data) ? body.data : (body.data ? [body.data] : []);
  return { status: res.status, record: arr[0] || null };
}

// ─── Extract job numbers from an API appointment's included jobs ───
function extractJobNumbers(apiAppt) {
  const jobs = apiAppt.jobs;
  if (!jobs) return [];
  const jobList = Array.isArray(jobs.data) ? jobs.data : (Array.isArray(jobs) ? jobs : []);
  return jobList.map((j) => (j && j.number ? String(j.number) : null)).filter(Boolean);
}

// ─── Map API appointment + job to Base44 Appointment record ───
function mapApiToBase44(apiAppt, apiJob, divisionMap) {
  const jobs = apiAppt.jobs;
  const jobList = jobs ? (Array.isArray(jobs.data) ? jobs.data : (Array.isArray(jobs) ? jobs : [])) : [];
  const job = apiJob || jobList[0] || null;

  const dt = (apiAppt.start_date_time || "").replace("T", " ");
  const customer = apiAppt.customer || {};
  const user = apiAppt.user || {};
  const createdBy = apiAppt.created_by || {};

  const divisionName = job && job.division_id != null && divisionMap[String(job.division_id)]
    ? (divisionMap[String(job.division_id)].name || "")
    : "";
  const isInsurance = job && job.insurance ? true : false;

  const customerName = (job && job.name) || customer.name ||
    [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
    apiAppt.title || "Unknown";

  return {
    appointment_record_id: String(apiAppt.id || ""),
    crm_lead_id: job && job.number ? String(job.number) : "",
    crm_job_id: job && job.id ? String(job.id) : "",
    customer_name: customerName,
    contact_name: customer.contact_name || "",
    phone: customer.phone || customer.mobile || "",
    email: customer.email || "",
    address: apiAppt.location || customer.address || customer.street || "",
    city: customer.city || "",
    lead_created_date: job && job.created_date ? String(job.created_date).slice(0, 10) : "",
    appointment_set_date: apiAppt.created_at ? String(apiAppt.created_at).slice(0, 10) : "",
    appointment_date: dt.slice(0, 10) || "",
    appointment_time: dt.slice(11, 16) || "",
    original_sales_rep: user.name || [user.first_name, user.last_name].filter(Boolean).join(" ") || "",
    original_appointment_setter: createdBy.name || [createdBy.first_name, createdBy.last_name].filter(Boolean).join(" ") || "",
    product: divisionName,
    business_division: isInsurance ? "Insurance" : "",
    trade: job && job.other_trade_type_description ? job.other_trade_type_description : "",
    title: apiAppt.title || "",
    appointment_status: "Set",
    debrief_status: "Missing",
    is_sales_appointment: true,
  };
}

// ─── Classification ───
const NON_SALES_KEYWORDS = [
  "solar", "unassigned", "warranty", "wcb", "sample",
  "walk thru", "walk through", "customer service",
  "inspection", "measurement", "production",
  "collection", "material delivery",
];
const RESIDENTIAL_TRADE_KEYWORDS = ["roofing replacement", "siding replacement", "roofing + siding", "roofing+siding", "roofing", "siding"];
const OTHER_TRADE_KEYWORDS = ["repair", "service", "commercial", "windows", "gutters", "doors", "masonry", "miscellaneous", "misc"];

function classifyFromApi(apiAppt, apiJob, divisionMap) {
  const title = (apiAppt?.title || "").toLowerCase();
  const base = { reporting_division: "Unclassified", classification_source: "no_match", classification_conflict: false, conflict_reason: null };

  if (NON_SALES_KEYWORDS.some((k) => title.includes(k))) {
    return { ...base, reporting_division: "Non-Sales", classification_source: "title_keyword" };
  }
  if (apiJob && apiJob.insurance) {
    return { ...base, reporting_division: "Insurance", classification_source: "api_insurance" };
  }
  if (apiJob && apiJob.division_id != null && divisionMap[String(apiJob.division_id)]) {
    const divName = (divisionMap[String(apiJob.division_id)].name || "").toLowerCase();
    if (RESIDENTIAL_TRADE_KEYWORDS.some((k) => divName.includes(k))) {
      return { ...base, reporting_division: "Residential Install", classification_source: "api_division" };
    }
    if (OTHER_TRADE_KEYWORDS.some((k) => divName.includes(k))) {
      return { ...base, reporting_division: "Other/MISC", classification_source: "api_division" };
    }
  }
  const tradeDesc = (apiJob?.other_trade_type_description || "").toLowerCase();
  if (tradeDesc) {
    if (RESIDENTIAL_TRADE_KEYWORDS.some((k) => tradeDesc.includes(k))) {
      return { ...base, reporting_division: "Residential Install", classification_source: "api_trade" };
    }
    if (OTHER_TRADE_KEYWORDS.some((k) => tradeDesc.includes(k))) {
      return { ...base, reporting_division: "Other/MISC", classification_source: "api_trade" };
    }
  }
  if (RESIDENTIAL_TRADE_KEYWORDS.some((k) => title.includes(k))) {
    return { ...base, reporting_division: "Residential Install", classification_source: "title_fallback" };
  }
  if (OTHER_TRADE_KEYWORDS.some((k) => title.includes(k))) {
    return { ...base, reporting_division: "Other/MISC", classification_source: "title_fallback" };
  }
  return base;
}

function deriveAppointmentType(apiAppt) {
  const title = (apiAppt?.title || "").toLowerCase();
  if (title.includes("reset")) return "Reset Demo";
  if (title.includes("rehash")) return "Rehash";
  return "First Appointment";
}

function isTwoLegEligible(classification, appointmentType) {
  if (classification.reporting_division !== "Residential Install") return false;
  return ["First Appointment", "Reset Demo", "Rehash"].includes(appointmentType);
}

// ─── Main handler ───
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden: admin role required" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const mode = body.mode || "dry_run";
    const date_from = body.date_from;
    const date_to = body.date_to;
    if (!date_from || !date_to) return Response.json({ error: "date_from and date_to required" }, { status: 400 });
    if (mode !== "dry_run" && mode !== "commit") return Response.json({ error: "mode must be dry_run or commit" }, { status: 400 });

    const token = secrets.get("LEAP_API_TOKEN");
    if (!token) return Response.json({ error: "LEAP_API_TOKEN not configured" }, { status: 500 });

    // Existing Base44 records (read-only — no writes in dry_run)
    const existingAppts = await base44.asServiceRole.entities.Appointment.list("-created_date", 500);
    const existingDebriefs = await base44.asServiceRole.entities.Debrief.list("-created_date", 500);

    // 1. Divisions
    const divResult = await fetchDivisions(token);
    const divisionMap = divResult.map || {};

    // 2. Appointments (documented date-filtered route)
    const apptResult = await fetchAppointments(token, date_from, date_to);
    const apiAppts = apptResult.appts;

    // 3. Extract included jobs + fetch full details by ID
    const { jobMap: includedJobMap, uniqueJobIds } = extractIncludedJobs(apiAppts);
    const jobDetailResult = await fetchJobsByIds(token, uniqueJobIds);

    // Merge: prefer full detail; fall back to included
    const mergedJobMap = {};  // number → job
    const mergedJobIdMap = {}; // id → job
    for (const id of uniqueJobIds) {
      const full = jobDetailResult.detailMap[id];
      const included = Object.values(includedJobMap).find((j) => String(j.id) === String(id));
      const merged = full || included;
      if (merged) {
        mergedJobIdMap[id] = merged;
        if (merged.number) mergedJobMap[merged.number] = merged;
      }
    }

    // Counts
    const counts = {
      api_appointments_examined: apptResult.totalExamined,
      api_appointments_unique: apiAppts.length,
      api_appointment_pages: apptResult.totalPages,
      unique_linked_jobs: uniqueJobIds.length,
      job_detail_batches: jobDetailResult.batches,
      job_details_fetched: jobDetailResult.totalFetched,
      appointment_results_available: 0,
      appointment_results_missing: 0,
      jobs_matched: 0,
      matches_by_appt_id: 0,
      matches_by_job_id: 0,
      matches_by_job_number_date: 0,
      matches_by_fallback: 0,
      existing_appointment_matches: 0,
      proposed_new_appointments: 0,
      created: 0,
      excluded_unmatched_candidates: 0,
      proposed_updates: 0,
      unchanged: 0,
      debriefs_matched: 0,
      debriefs_preserved: existingDebriefs.length,
      non_sales_exclusions: 0,
      classification_residential: 0,
      classification_other_misc: 0,
      classification_insurance: 0,
      classification_unclassified: 0,
      classification_non_sales: 0,
      classification_changes: 0,
      conflicts: 0,
      signed_sales_found: 0,
      signed_dates_available: 0,
      signed_dates_missing: 0,
      financial_summaries_fetched: 0,
      financial_summary_ok: 0,
      financial_summary_errors: 0,
      revenue_total: 0,
      sales_matched_debriefs: 0,
      sales_unmatched: 0,
      two_leg_denominator: 0,
      errors: 0,
      rate_limit_hits: 0,
      retries: 0,
    };
    const conflicts = [];
    const financialExceptions = [];
    const proposedNewRecords = [];

    // ── Match Base44 Appointments to API jobs by crm_lead_id (job number) ──
    for (const bAppt of existingAppts) {
      const jobNumber = bAppt.crm_lead_id;
      const apiJob = jobNumber ? mergedJobMap[jobNumber] : null;

      if (apiJob) {
        counts.jobs_matched++;
        counts.matches_by_job_id++;
        counts.existing_appointment_matches++;
        counts.unchanged++;

        const fakeAppt = { title: bAppt.title || "" };
        const classification = classifyFromApi(fakeAppt, apiJob, divisionMap);
        switch (classification.reporting_division) {
          case "Residential Install": counts.classification_residential++; break;
          case "Other/MISC": counts.classification_other_misc++; break;
          case "Insurance": counts.classification_insurance++; break;
          case "Non-Sales": counts.classification_non_sales++; break;
          default: counts.classification_unclassified++; break;
        }
        if (classification.reporting_division === "Non-Sales") counts.non_sales_exclusions++;

        // Conflict check
        if (apiJob.division_id != null && divisionMap[String(apiJob.division_id)] &&
            classification.classification_source !== "api_division" &&
            classification.classification_source !== "api_insurance") {
          const divName = (divisionMap[String(apiJob.division_id)].name || "").toLowerCase();
          const apiSays = RESIDENTIAL_TRADE_KEYWORDS.some((k) => divName.includes(k)) ? "Residential Install"
            : OTHER_TRADE_KEYWORDS.some((k) => divName.includes(k)) ? "Other/MISC" : null;
          if (apiSays && apiSays !== classification.reporting_division && classification.reporting_division !== "Unclassified" && classification.reporting_division !== "Non-Sales") {
            counts.conflicts++;
            conflicts.push({ category: "classification_conflict", reason: `API Division "${divName}" vs ${classification.classification_source} → "${classification.reporting_division}"` });
          }
        }

        // Classification change
        if (classification.classification_source.startsWith("api_") && bAppt.product) {
          if (bAppt.product.toLowerCase() !== classification.reporting_division.toLowerCase()) {
            counts.classification_changes++;
          }
        }

        // Two-leg
        const apptType = bAppt.appointment_type || deriveAppointmentType(fakeAppt);
        if (isTwoLegEligible(classification, apptType)) counts.two_leg_denominator++;

        // Signed sales + financials
        if (apiJob.contract_signed_date) {
          counts.signed_sales_found++;
          counts.signed_dates_available++;
          const matchedDebrief = existingDebriefs.find((d) => d.crm_lead_id === jobNumber);
          if (matchedDebrief) counts.sales_matched_debriefs++;
          else counts.sales_unmatched++;

          // Financial summary (underscore) — only for signed jobs, count revenue once per job
          counts.financial_summaries_fetched++;
          const finRes = await fetchFinancialSummary(token, apiJob.id);
          if (finRes.status === 200 && finRes.record) {
            counts.financial_summary_ok++;
            const r = finRes.record;
            const rev = r.total_job_revenue != null && r.total_job_revenue !== ""
              ? Number(r.total_job_revenue)
              : (Number(r.total_job_price || 0) + Number(r.total_change_order_amount || 0));
            counts.revenue_total += isNaN(rev) ? 0 : rev;
          } else {
            counts.financial_summary_errors++;
            financialExceptions.push({ job_id: apiJob.id, status: finRes.status });
          }
        } else {
          counts.signed_dates_missing++;
        }
      } else {
        // No API job in filtered range — classify from title only
        const fakeAppt = { title: bAppt.title || "" };
        const classification = classifyFromApi(fakeAppt, null, divisionMap);
        if (classification.reporting_division === "Non-Sales") { counts.non_sales_exclusions++; counts.classification_non_sales++; }
        else if (classification.reporting_division === "Residential Install") counts.classification_residential++;
        else if (classification.reporting_division === "Other/MISC") counts.classification_other_misc++;
        else if (classification.reporting_division === "Insurance") counts.classification_insurance++;
        else counts.classification_unclassified++;
        const apptType = bAppt.appointment_type || deriveAppointmentType(fakeAppt);
        if (isTwoLegEligible(classification, apptType)) counts.two_leg_denominator++;
      }
    }

    // ── API appointments: results + new candidates (match by appt id OR linked job number) ──
    for (const apiAppt of apiAppts) {
      const hasResult = (Array.isArray(apiAppt.result) && apiAppt.result.length > 0) || apiAppt.result_option_id != null;
      if (hasResult) counts.appointment_results_available++;
      else counts.appointment_results_missing++;

      // Match to Base44 by appointment_record_id
      const byApptId = existingAppts.find((a) => a.appointment_record_id && a.appointment_record_id === String(apiAppt.id));
      // Match to Base44 by linked job number (crm_lead_id)
      const jobNumbers = extractJobNumbers(apiAppt);
      const byJobNumber = jobNumbers.length > 0
        ? existingAppts.find((a) => a.crm_lead_id && jobNumbers.includes(String(a.crm_lead_id)))
        : null;

      if (byApptId) {
        counts.matches_by_appt_id++;
      } else if (byJobNumber) {
        counts.matches_by_job_number_date++;
      } else {
        // Unmatched candidate — exclude non-sales, count remainder as proposed new
        const title = (apiAppt.title || "").toLowerCase();
        const isNonSales = NON_SALES_KEYWORDS.some((k) => title.includes(k));
        if (isNonSales) {
          counts.excluded_unmatched_candidates++;
        } else {
          counts.proposed_new_appointments++;
          const firstJobNumber = jobNumbers.length > 0 ? jobNumbers[0] : null;
          const apiJob = firstJobNumber ? mergedJobMap[firstJobNumber] : null;
          proposedNewRecords.push(mapApiToBase44(apiAppt, apiJob, divisionMap));
        }
      }
    }

    // ── Commit: create proposed new appointments (idempotent — matched on next run) ──
    if (mode === "commit" && proposedNewRecords.length > 0) {
      try {
        const created = await base44.asServiceRole.entities.Appointment.bulkCreate(proposedNewRecords);
        counts.created = Array.isArray(created) ? created.length : 0;
      } catch (e) {
        stats.errors.push(`commit_create: ${e.message}`);
      }
    }

    // ── Debriefs matched ──
    for (const d of existingDebriefs) {
      const matched = existingAppts.some((a) => a.crm_lead_id && a.crm_lead_id === d.crm_lead_id);
      if (matched) counts.debriefs_matched++;
    }

    counts.errors = stats.errors.length;
    counts.rate_limit_hits = stats.rateLimitHits;
    counts.retries = stats.retries;

    return Response.json({
      mode,
      date_from,
      date_to,
      no_writes: mode === "dry_run",
      idempotent: true,
      created: counts.created,
      base44_appointments: existingAppts.length,
      base44_debriefs: existingDebriefs.length,
      endpoint_statuses: endpointStatuses,
      division_map: { status: divResult.status, size: Object.keys(divisionMap).length },
      appointments: { status: apptResult.firstStatus, total_pages: apptResult.totalPages, examined: apptResult.totalExamined, unique: apiAppts.length },
      jobs_by_ids: { status: jobDetailResult.status, batches: jobDetailResult.batches, fetched: jobDetailResult.totalFetched, unique_ids: uniqueJobIds.length },
      counts,
      conflicts: conflicts.slice(0, 20),
      financial_exceptions: financialExceptions,
      errors: stats.errors.slice(0, 10),
    });
  } catch (error) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
}