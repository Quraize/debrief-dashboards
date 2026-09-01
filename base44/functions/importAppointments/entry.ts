import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

// ── Sales-appointment classification (mirrors src/lib/salesAppointment.js) ──
const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase().replace(/\s+/g, " "));
const EXCLUDE_KEYWORDS = [
  "sample", "walk thru", "walkthrough", "walk through",
  "customer service", "warranty", "wcb", "inspection",
  "measure", "measurement", "install", "production",
  "collection", "material delivery", "solar", "unassigned",
];
function classifySalesAppointment(title) {
  const t = norm(title);
  if (!t) return { isSales: false, reason: "Unassigned — no title" };
  for (const kw of EXCLUDE_KEYWORDS) {
    if (t.includes(kw)) return { isSales: false, reason: `Excluded — ${String(title).trim() || kw}` };
  }
  if (/\best\b/.test(t)) return { isSales: true, reason: null };
  return { isSales: false, reason: `Non-EST — ${String(title).trim() || "untitled"}` };
}
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin' && user.role !== 'sales_manager') {
      return Response.json({ error: 'Forbidden: admin or sales_manager role required' }, { status: 403 });
    }

    const body = await req.json();
    const fileUrl = body.file_url;
    if (!fileUrl) return Response.json({ error: 'file_url is required' }, { status: 400 });

    // Extract structured data from the uploaded CSV/Excel file
    const extractResult = await base44.asServiceRole.integrations.Core.ExtractDataFromUploadedFile({
      file_url: fileUrl,
      json_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Appointment Title from JobProgress — e.g. ROOF EST, REPAIR EST, SIDING EST, MISC EST, REHASH ROOF EST, NO SEE ROOF EST, Warranty Callback, Sample, Walk Thru, Customer Service, Solar, Inspection, SA. This is the Title column." },
          lead_id: { type: "string", description: "JobProgress Lead Id / Lead ID / LeadId / CRM Lead ID — primary external CRM identifier" },
          job_id: { type: "string", description: "JobProgress Job Id / Job ID / JobId / JobProgress ID / CRM Job ID — job identifier" },
          customer_name: { type: "string", description: "Customer Name column — the customer or job name" },
          contact_name: { type: "string", description: "Contact Name — the individual contact person, if separate from the customer/job name" },
          phone: { type: "string" },
          email: { type: "string" },
          address: { type: "string" },
          city: { type: "string" },
          county: { type: "string" },
          lead_created_date: { type: "string", description: "Created Date — when the JobProgress lead/record was created" },
          appointment_set_date: { type: "string" },
          appointment_date: { type: "string", description: "Start Date — the appointment date" },
          appointment_time: { type: "string", description: "Start Time — the appointment time" },
          start_date_time: { type: "string", description: "Start Date Time — combined date/time if separate columns are not available" },
          appointment_result: { type: "string", description: "Appointment Result — e.g. Sold, No Sale, No Demo, No Show, blank" },
          sales_rep: { type: "string" },
          appointment_setter: { type: "string" },
          product: { type: "string" },
          referral_source: { type: "string" },
          source_category: { type: "string" },
          appointment_status: { type: "string" },
          division: { type: "string", description: "Division column — e.g. Insurance, Residential, Commercial" },
          trade: { type: "string", description: "Trade column — Roofing, Siding, Gutters, Windows, Doors, Chimney, Masonry, Other" },
          notes: { type: "string" }
        }
      }
    });

    if (extractResult.status !== "success" || !extractResult.output) {
      return Response.json({ error: "Failed to extract data from file", details: extractResult.details }, { status: 500 });
    }

    const rawRecords = Array.isArray(extractResult.output) ? extractResult.output : [extractResult.output];

    // ── Reject header/metadata rows ──
    // A row is a header repeat if customer_name is exactly "Customer Name" or the ID field is exactly "Job Id".
    const isHeaderRow = (r) => {
      const cn = norm(r.customer_name);
      const jid = norm(r.job_id || r.lead_id || r.crm_lead_id || r.crm_job_id);
      if (cn === "customer name" || jid === "job id") return true;
      // Metadata row: no customer name AND no ID AND no date
      if (!r.customer_name && !r.job_id && !r.lead_id && !r.crm_lead_id && !r.appointment_date && !r.start_date_time) return true;
      return false;
    };
    const validRecords = rawRecords.filter((r) => !isHeaderRow(r));
    const invalidHeaderRows = rawRecords.length - validRecords.length;

    // ── Normalizers ──
    function normalizeDate(val) {
      if (!val) return "";
      const s = String(val).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return s;
    }
    function normalizeTime(val) {
      if (!val) return "";
      const s = String(val).trim();
      // If it's a combined date-time, extract the time portion
      const dtMatch = s.match(/\d{4}-\d{2}-\d{2}[T ](\d{1,2}:\d{2})/);
      if (dtMatch) return dtMatch[1];
      return s;
    }
    function parseStartDateTime(val) {
      if (!val) return { date: "", time: "" };
      const s = String(val).trim();
      const d = new Date(s);
      if (!isNaN(d.getTime())) {
        return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
      }
      return { date: "", time: "" };
    }
    function normalizePhone(val) {
      if (!val) return "";
      const digits = String(val).replace(/\D/g, "");
      return digits.length >= 10 ? digits.slice(-10) : digits;
    }
    const normId = (v) => (v == null ? "" : String(v).trim());
    const isValidId = (id) => id != null && String(id).trim() !== "" && String(id).trim().toLowerCase() !== "undefined";

    // ── Appointment-type normalizer (mirrors src/lib/appointmentTypes.js) ──
    // The backend cannot import the frontend helper, so an equivalent is maintained here.
    // Maps legacy spellings (New Appointment, Re-engagement, Reengagement, etc.) to canonical
    // labels (First Appointment, Rehash) before any persistence or matching.
    const APPT_NORMALIZE_MAP: Record<string, string> = {
      "first appointment": "First Appointment",
      "new appointment": "First Appointment",
      "first appt": "First Appointment",
      "reset demo": "Reset Demo",
      "rehash": "Rehash",
      "re-engagement": "Rehash",
      "re engagement": "Rehash",
      "reengagement": "Rehash",
      "re hash": "Rehash",
    };
    function normalizeAppointmentType(raw: any): string {
      if (!raw) return "";
      const key = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
      return APPT_NORMALIZE_MAP[key] || String(raw).trim();
    }
    function compositeRecordId(externalId, date, time) {
      const parts = [externalId || "", date || "", (time || "").trim()].filter(Boolean);
      return parts.length ? parts.join("|") : "";
    }
    function canonicalKey(externalId, date, time) {
      return `${norm(externalId)}|${(date || "").trim()}|${norm(time)}`;
    }

    // ── Map raw records to normalized form + classify ──
    const mapped = validRecords.map((rec) => {
      const leadId = normId(rec.lead_id || rec.crm_lead_id);
      const jobId = normId(rec.job_id || rec.crm_job_id);
      const externalId = leadId || jobId;
      let apptDate = normalizeDate(rec.appointment_date);
      let apptTime = normalizeTime(rec.appointment_time);
      // Fallback: parse combined Start Date Time
      if ((!apptDate || !apptTime) && rec.start_date_time) {
        const parsed = parseStartDateTime(rec.start_date_time);
        if (!apptDate) apptDate = parsed.date;
        if (!apptTime) apptTime = parsed.time;
      }
      const title = (rec.title || "").trim();
      const classification = classifySalesAppointment(title);
      return {
        title,
        crm_lead_id: externalId,
        crm_job_id: jobId || externalId,
        appointment_record_id: compositeRecordId(externalId, apptDate, apptTime),
        customer_name: (rec.customer_name || "").trim(),
        contact_name: (rec.contact_name || "").trim(),
        phone: (rec.phone || "").trim(),
        email: (rec.email || "").trim(),
        address: (rec.address || "").trim(),
        city: (rec.city || "").trim(),
        county: (rec.county || "").trim(),
        lead_created_date: normalizeDate(rec.lead_created_date),
        appointment_set_date: normalizeDate(rec.appointment_set_date),
        appointment_date: apptDate,
        appointment_time: apptTime,
        appointment_result: (rec.appointment_result || "").trim(),
        original_sales_rep: (rec.sales_rep || "").trim(),
        original_appointment_setter: (rec.appointment_setter || "").trim(),
        product: rec.product || "",
        referral_source: rec.referral_source || "",
        source_category: rec.source_category || "",
        appointment_status: rec.appointment_status || "Set",
        notes: rec.notes || "",
        division: (rec.division || "").trim(),
        trade: (rec.trade || "").trim(),
        business_division: (rec.division || "").trim().toLowerCase() === "insurance" ? "Insurance" : "",
        is_sales_appointment: classification.isSales,
        exclusion_reason: classification.reason || "",
        _source_created_date: rec.lead_created_date || "",
      };
    });

    // ── Source-level deduplication: canonical key = external ID + date + time ──
    // Same Job ID on a different date/time is a separate appointment. Suppress exact
    // duplicates within the upload; keep the newest Created Date and prefer nonblank fields.
    const groups = {};
    mapped.forEach((m) => {
      const key = canonicalKey(m.crm_lead_id, m.appointment_date, m.appointment_time);
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    });
    const deduped = [];
    const suppressedDuplicates = [];
    Object.values(groups).forEach((group) => {
      if (group.length === 1) { deduped.push(group[0]); return; }
      // Pick best: newest source_created_date, then most nonblank fields
      const score = (m) => {
        let s = 0;
        if (m._source_created_date) s += 100000; // newest created date wins
        ["customer_name", "phone", "address", "appointment_result", "original_sales_rep", "original_appointment_setter", "product", "title"].forEach((f) => {
          if (m[f]) s += 1;
        });
        return s;
      };
      group.sort((a, b) => {
        const ca = a._source_created_date ? new Date(a._source_created_date).getTime() || 0 : 0;
        const cb = b._source_created_date ? new Date(b._source_created_date).getTime() || 0 : 0;
        if (cb !== ca) return cb - ca;
        return score(b) - score(a);
      });
      deduped.push(group[0]);
      for (let i = 1; i < group.length; i++) {
        suppressedDuplicates.push(group[i]);
      }
    });

    // ── Fetch existing appointments for matching ──
    const existing = await base44.asServiceRole.entities.Appointment.list("-created_date", 500);

    let added = 0, updated = 0, excludedNonSales = 0, insuranceCount = 0;
    const errors = [];
    const ambiguous = [];
    const missingFields = [];
    const excludedRows = [];
    const auditRecords = [];
    const importBatchId = `imp-${Date.now()}`;
    const importedAt = new Date().toISOString();
    const importedBy = user.email || user.full_name || "";

    const toCreate = [];
    const toUpdate = [];

    for (const m of deduped) {
      try {
        // Count insurance rows
        if (m.business_division === "Insurance") insuranceCount++;

        // Audit non-sales rows
        if (!m.is_sales_appointment) {
          excludedNonSales++;
          excludedRows.push({
            title: m.title, customer_name: m.customer_name, crm_lead_id: m.crm_lead_id,
            appointment_date: m.appointment_date, appointment_time: m.appointment_time,
            reason: m.exclusion_reason, row_type: "excluded_non_sales"
          });
          auditRecords.push({
            import_batch_id: importBatchId, imported_at: importedAt, imported_by: importedBy,
            title: m.title, customer_name: m.customer_name, crm_lead_id: m.crm_lead_id,
            appointment_date: m.appointment_date, appointment_time: m.appointment_time,
            exclusion_reason: m.exclusion_reason, row_type: "excluded_non_sales"
          });
        }

        const flags = [];
        if (!m.customer_name) flags.push("Missing customer name");
        if (!m.phone) flags.push("Missing phone");
        if (!m.appointment_date) flags.push("Missing appointment date");
        if (!m.original_sales_rep) flags.push("Missing sales rep");

        // Canonical resolution — never guess on multiple candidates.
        let match = null;
        let matchMethod = null;
        let fallbackFlagged = false;
        if (m.crm_lead_id && m.appointment_date) {
          if (m.appointment_time) {
            const matches = existing.filter((a) =>
              norm(a.crm_lead_id) === norm(m.crm_lead_id) &&
              a.appointment_date === m.appointment_date &&
              a.appointment_time && norm(a.appointment_time) === norm(m.appointment_time)
            );
            if (matches.length === 1) { match = matches[0]; matchMethod = "Lead ID + Date/Time"; }
            else if (matches.length > 1) {
              ambiguous.push({ customer_name: m.customer_name, crm_lead_id: m.crm_lead_id, appointment_date: m.appointment_date, reason: "Multiple appointments match Lead ID + Date/Time" });
              continue;
            }
          }
          if (!match) {
            const matches = existing.filter((a) =>
              norm(a.crm_lead_id) === norm(m.crm_lead_id) &&
              a.appointment_date === m.appointment_date
            );
            if (matches.length === 1) { match = matches[0]; matchMethod = "Lead ID + Date"; }
            else if (matches.length > 1) {
              ambiguous.push({ customer_name: m.customer_name, crm_lead_id: m.crm_lead_id, appointment_date: m.appointment_date, reason: "Multiple appointments match Lead ID + Date" });
              continue;
            }
          }
        }
        // Fallback: Phone (only when no external ID)
        if (!match && !m.crm_lead_id && m.phone) {
          const clean = normalizePhone(m.phone);
          if (clean.length >= 10) {
            const matches = existing.filter((a) => a.phone && normalizePhone(a.phone) === clean);
            if (matches.length === 1) { match = matches[0]; matchMethod = "Phone"; fallbackFlagged = true; }
            else if (matches.length > 1) {
              ambiguous.push({ customer_name: m.customer_name, phone: m.phone, reason: "Multiple appointments match phone" });
              continue;
            }
          }
        }
        // Fallback: Customer Name + Date (only when no external ID)
        if (!match && !m.crm_lead_id && m.customer_name && m.appointment_date) {
          const matches = existing.filter((a) =>
            a.customer_name && norm(a.customer_name) === norm(m.customer_name) &&
            a.appointment_date === m.appointment_date
          );
          if (matches.length === 1) { match = matches[0]; matchMethod = "Name + Date"; fallbackFlagged = true; }
          else if (matches.length > 1) {
            ambiguous.push({ customer_name: m.customer_name, appointment_date: m.appointment_date, reason: "Multiple appointments match Name + Date" });
            continue;
          }
        }
        if (fallbackFlagged) flags.push("Fallback match — review");

        // Strip internal helper field
        const { _source_created_date, ...recordData } = m;

        if (match) {
          if (!isValidId(match.id)) {
            errors.push({ customer_name: m.customer_name, error: "Matched appointment has no valid internal id — skipped update" });
            continue;
          }
          const preservedDebriefStatus = match.debrief_status && match.debrief_status !== "Missing" ? match.debrief_status : "Missing";
          const preservedRecordId = match.appointment_record_id || m.appointment_record_id || "";
          toUpdate.push({
            id: match.id, ...recordData,
            appointment_record_id: preservedRecordId,
            debrief_status: preservedDebriefStatus
          });
          updated++;
        } else {
          toCreate.push({ ...recordData, debrief_status: "Missing" });
          added++;
        }

        if (flags.length > 0) {
          missingFields.push({ customer_name: m.customer_name || "(unnamed)", phone: m.phone, appointment_date: m.appointment_date, flags });
        }
      } catch (err) {
        errors.push({ error: err.message });
      }
    }

    // Audit deduplicated rows
    suppressedDuplicates.forEach((m) => {
      excludedRows.push({
        title: m.title, customer_name: m.customer_name, crm_lead_id: m.crm_lead_id,
        appointment_date: m.appointment_date, appointment_time: m.appointment_time,
        reason: "Duplicate suppressed within upload", row_type: "deduplicated"
      });
      auditRecords.push({
        import_batch_id: importBatchId, imported_at: importedAt, imported_by: importedBy,
        title: m.title, customer_name: m.customer_name, crm_lead_id: m.crm_lead_id,
        appointment_date: m.appointment_date, appointment_time: m.appointment_time,
        exclusion_reason: "Duplicate suppressed within upload", row_type: "deduplicated"
      });
    });
    // Audit invalid/header rows
    for (let i = 0; i < invalidHeaderRows; i++) {
      excludedRows.push({
        title: "", customer_name: "", crm_lead_id: "",
        appointment_date: "", appointment_time: "",
        reason: "Invalid or header row", row_type: "invalid_header"
      });
    }

    // ── Bulk upsert ──
    if (toCreate.length > 0) {
      for (let i = 0; i < toCreate.length; i += 200) {
        await base44.asServiceRole.entities.Appointment.bulkCreate(toCreate.slice(i, i + 200));
      }
    }
    if (toUpdate.length > 0) {
      for (let i = 0; i < toUpdate.length; i += 200) {
        await base44.asServiceRole.entities.Appointment.bulkUpdate(toUpdate.slice(i, i + 200));
      }
    }
    // Write audit records
    if (auditRecords.length > 0) {
      for (let i = 0; i < auditRecords.length; i += 200) {
        await base44.asServiceRole.entities.AppointmentImportExclusion.bulkCreate(auditRecords.slice(i, i + 200));
      }
    }

    return Response.json({
      total: rawRecords.length,
      added,
      updated,
      duplicatesSuppressed: suppressedDuplicates.length,
      excludedNonSales,
      invalidHeaderRows,
      errors,
      ambiguous,
      missingFields,
      excludedRows,
      // Backward-compatible aliases
      duplicates: suppressedDuplicates.length,
      skippedDuplicate: suppressedDuplicates.length,
      skippedAmbiguous: ambiguous.length,
      insuranceCount,
      importBatchId
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}