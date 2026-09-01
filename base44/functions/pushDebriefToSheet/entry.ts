import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';

// Columns A–AN only (indices 0–39). AO:BF are helper/formula columns with ARRAYFORMULAs — never write to them.
const MAX_COL = 40;

function cellIdMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const debriefId = body.debrief_id;
    if (!debriefId) return Response.json({ error: 'debrief_id is required' }, { status: 400 });

    // Fetch the debrief
    const debrief = await base44.asServiceRole.entities.Debrief.get(debriefId);
    if (!debrief) return Response.json({ error: 'Debrief not found' }, { status: 404 });

    // Authorization: a debrief may only be pushed to the master sheet by its own author
    // or by a manager/admin. Without this, any authenticated user could pass an arbitrary
    // debrief_id and append rows to the company sheet using the shared OAuth connector token.
    // Owner-based (not role-based) so the entity-create workflow, which fires as the
    // submitting user, keeps working.
    const isManager = user.role === 'admin' || user.role === 'sales_manager';
    const isOwner = !!debrief.created_by && !!user.email &&
      String(debrief.created_by).trim().toLowerCase() === String(user.email).trim().toLowerCase();
    if (!isManager && !isOwner) {
      return Response.json({ error: 'Forbidden: you may only push your own debriefs' }, { status: 403 });
    }

    // Fetch appointments for matching (to pull in lead data not on the debrief)
    const appointments = await base44.asServiceRole.entities.Appointment.list("-created_date", 500);
    const apptByLead: Record<string, any> = {};
    appointments.forEach((a: any) => { if (a.crm_lead_id) apptByLead[a.crm_lead_id.toLowerCase()] = a; });
    const a: any = (debrief.crm_lead_id && apptByLead[debrief.crm_lead_id.toLowerCase()]) || {};

    // Outcome constants (must match src/lib/constants.js)
    const SALE_CREDIT_DECLINE_OUTCOME = "Demo Completed — Sale / Credit Decline";
    const SALE_CANCELLATION_OUTCOME = "Demo Completed — Sale / Cancellation";
    const CREDIT_DECLINE_CLOSE = "Credit Decline";
    const CANCELLATION_CLOSE = "Cancellation";
    const isCreditDecline = debrief.appointment_outcome === SALE_CREDIT_DECLINE_OUTCOME || debrief.sale_close_type === CREDIT_DECLINE_CLOSE;
    const isCancellation = debrief.appointment_outcome === SALE_CANCELLATION_OUTCOME || debrief.sale_close_type === CANCELLATION_CLOSE;

    // ── Build Debrief Responses row — column order matches buildExportRows in src/lib/kpi.js ──
    let debriefRow = [
      debrief.crm_lead_id || a.crm_lead_id || "",
      debrief.customer_name || "",
      "",
      debrief.appointment_date || a.appointment_date || "",
      debrief.sales_rep || a.original_sales_rep || "",
      debrief.appointment_setter || a.original_appointment_setter || "",
      debrief.marketing_source || a.marketing_source || "",
      debrief.referral_source || a.referral_source || "",
      debrief.product || a.product || "",
      debrief.appointment_outcome || "",
      debrief.decision_maker_status || "",
      debrief.first_price_given || "",
      debrief.additional_prices_given || "",
      debrief.prices_given || "",
      debrief.financing_offered ? "Yes" : "No",
      debrief.financing_result || "",
      debrief.main_objection || "",
      debrief.pre_close_answer || "",
      debrief.closing_question_answer || "",
      debrief.rep_response || "",
      debrief.reset_needed ? "Yes" : "No",
      debrief.reset_date || "",
      debrief.follow_up_needed ? "Yes" : "No",
      debrief.follow_up_date || "",
      debrief.sale_amount || "",
      debrief.sale_close_type || "",
      isCreditDecline ? "Yes" : "No",
      isCancellation ? "Yes" : "No",
      debrief.cancellation_reason || "",
      debrief.submitted_by || "",
      debrief.created_date ? new Date(debrief.created_date).toISOString() : "",
      debrief.notes || "",
      debrief.data_quality_flag || ""
    ];

    // Get Google Sheets OAuth token
    const { accessToken } = await base44.asServiceRole.connectors.getConnection("googlesheets");
    const spreadsheetId = secrets.get("GOOGLE_SHEETS_SPREADSHEET_ID");
    if (!spreadsheetId) return Response.json({ error: 'GOOGLE_SHEETS_SPREADSHEET_ID secret not set' }, { status: 500 });

    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Append to "Debrief Responses" (always — never skip)
    // ═══════════════════════════════════════════════════════════════
    let debriefAppended = 0;
    const debriefSheetName = "Debrief Responses";

    // Extend debriefRow with Address and City via header-name mapping (only if headers exist)
    const debriefHeaderResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(debriefSheetName)}!A1:AN1`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );
    if (debriefHeaderResp.ok) {
      const debriefHeaderData = await debriefHeaderResp.json();
      const debriefHeaders: string[] = debriefHeaderData.values?.[0] || [];
      const debriefHeaderMap: Record<string, number> = {};
      debriefHeaders.forEach((h, i) => {
        const text = (h || "").trim();
        if (text) debriefHeaderMap[text] = i;
      });
      const addrIdx = debriefHeaderMap["Address"];
      const cityIdx = debriefHeaderMap["City"];
      // Insurance fields — only written if the sheet has matching headers
      const insFields: Record<string, string> = {
        "Secondary Sales Rep": debrief.secondary_sales_rep || "",
        "Primary Split %": debrief.primary_rep_split_pct != null ? String(debrief.primary_rep_split_pct) : (debrief.secondary_sales_rep ? "" : "100"),
        "Secondary Split %": debrief.secondary_rep_split_pct != null ? String(debrief.secondary_rep_split_pct) : "",
        "Primary Revenue Credit": (debrief.sale_amount && debrief.primary_rep_split_pct != null) ? String(Math.round(Number(debrief.sale_amount) * Number(debrief.primary_rep_split_pct) / 100)) : (debrief.sale_amount != null ? String(debrief.sale_amount) : ""),
        "Secondary Revenue Credit": (debrief.sale_amount && debrief.secondary_sales_rep && debrief.secondary_rep_split_pct != null) ? String(Math.round(Number(debrief.sale_amount) * Number(debrief.secondary_rep_split_pct) / 100)) : "",
        "Business Division": debrief.business_division || "",
        "Trade": debrief.trade || "",
        "Contingency Signed": debrief.contingency_signed === true ? "Yes" : (debrief.contingency_signed === false ? "No" : ""),
        "Contingency Signed Date": debrief.contingency_signed_date || "",
        "Demo Completed": debrief.demo_completed === true ? "Yes" : (debrief.demo_completed === false ? "No" : ""),
        "Insurance Outcome": debrief.insurance_outcome || "",
        "Upgrade Price 1": debrief.upgrade_price_1 != null ? String(debrief.upgrade_price_1) : "",
        "Upgrade Price 2": debrief.upgrade_price_2 != null ? String(debrief.upgrade_price_2) : "",
        "Upgrade Price 3": debrief.upgrade_price_3 != null ? String(debrief.upgrade_price_3) : "",
        "Other Prices Given": debrief.other_prices_given === true ? "Yes" : (debrief.other_prices_given === false ? "No" : ""),
        "Other Prices Details": debrief.other_prices_details || "",
        "Other Prices Amount": debrief.other_prices_amount != null ? String(debrief.other_prices_amount) : "",
        "Total Job Price Provided": debrief.total_job_price_provided === true ? "Yes" : (debrief.total_job_price_provided === false ? "No" : ""),
        "Total Job Price": debrief.total_job_price != null ? String(debrief.total_job_price) : "",
        "Upgrade Sold Accepted": debrief.upgrade_sold_accepted === true ? "Yes" : (debrief.upgrade_sold_accepted === false ? "No" : ""),
        "Accepted Upgrade Amount": debrief.accepted_upgrade_amount != null ? String(debrief.accepted_upgrade_amount) : "",
        "Final Contract Signed": debrief.final_contract_signed === true ? "Yes" : (debrief.final_contract_signed === false ? "No" : ""),
        "Final Contract Date": debrief.final_contract_date || "",
      };
      const insIndices = Object.entries(insFields)
        .map(([hdr, val]) => ({ idx: debriefHeaderMap[hdr], val }))
        .filter((x) => x.idx !== undefined);
      const maxIdx = Math.max(addrIdx ?? -1, cityIdx ?? -1, ...insIndices.map((x) => x.idx));
      if (maxIdx >= 0) {
        const padded: string[] = new Array(Math.max(debriefRow.length, maxIdx + 1)).fill("");
        for (let i = 0; i < debriefRow.length; i++) padded[i] = debriefRow[i];
        if (addrIdx !== undefined) padded[addrIdx] = debrief.address || "";
        if (cityIdx !== undefined) padded[cityIdx] = debrief.city || "";
        for (const x of insIndices) padded[x.idx] = x.val;
        debriefRow = padded;
      }
    }

    const debriefUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(debriefSheetName)}!A:A:append?insertDataOption=INSERT_ROWS&valueInputOption=RAW`;
    const debriefResp = await fetch(debriefUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [debriefRow] })
    });
    if (!debriefResp.ok) {
      const errorText = await debriefResp.text();
      return Response.json({ error: `Google Sheets API error (Debrief Responses): ${errorText}` }, { status: 500 });
    }
    const debriefResult = await debriefResp.json();
    debriefAppended = debriefResult.updates?.updatedRows || 0;

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Upsert "Lead Sheet" by Lead ID
    // ═══════════════════════════════════════════════════════════════
    const leadSheetName = "Lead Sheet";
    const leadId: string = (debrief.crm_lead_id || a.crm_lead_id || "").trim();

    // Never match blank Lead IDs
    if (!leadId) {
      return Response.json({
        success: true,
        debriefAppended,
        leadSheetAction: "skipped_missing_lead_id",
        leadSheetRow: null,
        leadId: null,
        duplicateLeadIdCount: 0,
        warning: "Blank lead_id — Lead Sheet upsert skipped."
      });
    }

    // Read header row (A1:AN1) and map by exact header text
    const headerResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(leadSheetName)}!A1:AN1`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );
    if (!headerResp.ok) {
      const errorText = await headerResp.text();
      return Response.json({
        success: true,
        debriefAppended,
        leadSheetAction: "skipped_missing_lead_id",
        leadSheetRow: null,
        leadId,
        duplicateLeadIdCount: 0,
        warning: `Could not read Lead Sheet headers: ${errorText}`
      });
    }
    const headerData = await headerResp.json();
    const rawHeaders: string[] = headerData.values?.[0] || [];
    const headerMap: Record<string, number> = {};
    rawHeaders.forEach((h, i) => {
      const text = (h || "").trim();
      if (text && i < MAX_COL) headerMap[text] = i;
    });

    const leadIdCol = headerMap["CRM Lead ID"];
    if (leadIdCol === undefined) {
      return Response.json({
        success: true,
        debriefAppended,
        leadSheetAction: "skipped_missing_lead_id",
        leadSheetRow: null,
        leadId,
        duplicateLeadIdCount: 0,
        warning: "CRM Lead ID column not found in Lead Sheet headers."
      });
    }

    // Read all data rows (A2:AN)
    const dataResp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(leadSheetName)}!A2:AN`,
      { headers: { "Authorization": `Bearer ${accessToken}` } }
    );
    if (!dataResp.ok) {
      const errorText = await dataResp.text();
      return Response.json({
        success: true,
        debriefAppended,
        leadSheetAction: "skipped_missing_lead_id",
        leadSheetRow: null,
        leadId,
        duplicateLeadIdCount: 0,
        warning: `Could not read Lead Sheet data: ${errorText}`
      });
    }
    const dataJson = await dataResp.json();
    const dataRows: any[][] = dataJson.values || [];

    // Find matching rows by CRM Lead ID (case-insensitive, never blank)
    const matchIndices: number[] = [];
    dataRows.forEach((row, idx) => {
      const cellVal = (row[leadIdCol] || "").trim();
      if (cellVal && cellIdMatch(cellVal, leadId)) {
        matchIndices.push(idx);
      }
    });

    // Field mappings: submission field -> Lead Sheet header(s)
    const fieldMappings = [
      { getValue: () => leadId, headers: ["CRM Lead ID"] },
      { getValue: () => debrief.customer_name || "", headers: ["Customer Name"] },
      { getValue: () => debrief.address || "", headers: ["Address"] },
      { getValue: () => debrief.city || "", headers: ["City"] },
      { getValue: () => debrief.appointment_date || a.appointment_date || "", headers: ["Appointment Date"] },
      { getValue: () => debrief.sales_rep || a.original_sales_rep || "", headers: ["Original Sales Rep"] },
      { getValue: () => debrief.appointment_setter || a.original_appointment_setter || "", headers: ["Original Appointment Setter"] },
      { getValue: () => debrief.marketing_source || a.marketing_source || "", headers: ["Original Source", "Source Category"] },
      { getValue: () => debrief.referral_source || a.referral_source || "", headers: ["Referral Source"] },
      { getValue: () => debrief.product || a.product || "", headers: ["Product"] },
      { getValue: () => debrief.appointment_outcome || "", headers: ["Appointment Outcome"] },
      { getValue: () => debrief.sale_close_type || "", headers: ["Sale / Close Type"] },
      { getValue: () => debrief.sale_amount != null ? String(debrief.sale_amount) : "", headers: ["Sale Amount", "Total Sales"] },
      { getValue: () => debrief.reset_needed === true ? "Yes" : (debrief.reset_needed === false ? "No" : ""), headers: ["Reset Status"] }
    ];

    // Build update row: start from existing, overlay only nonblank incoming values
    function buildUpdateRow(existing: any[]): string[] {
      const row = new Array(MAX_COL).fill("");
      for (let i = 0; i < Math.min(existing.length, MAX_COL); i++) {
        row[i] = existing[i] || "";
      }
      for (const m of fieldMappings) {
        const val = m.getValue();
        if (val) {
          for (const hdr of m.headers) {
            const colIdx = headerMap[hdr];
            if (colIdx !== undefined && colIdx < MAX_COL) {
              row[colIdx] = val;
            }
          }
        }
      }
      return row;
    }

    // Build insert row: defaults + field mappings
    function buildInsertRow(): string[] {
      const row = new Array(MAX_COL).fill("");
      const createdDate = debrief.created_date
        ? new Date(debrief.created_date).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];
      const defaults: Record<string, string> = {
        "Lead Type": "Debrief",
        "Lead Created Date": createdDate,
        "Appointment Set?": debrief.appointment_date ? "Yes" : "",
        "Lead Validity": "Needs Review",
        "Import Source": "Base44 Debrief",
        "Review Flag": "Review — created from debrief"
      };
      for (const [hdr, val] of Object.entries(defaults)) {
        const colIdx = headerMap[hdr];
        if (colIdx !== undefined && colIdx < MAX_COL) {
          row[colIdx] = val;
        }
      }
      for (const m of fieldMappings) {
        const val = m.getValue();
        if (val) {
          for (const hdr of m.headers) {
            const colIdx = headerMap[hdr];
            if (colIdx !== undefined && colIdx < MAX_COL) {
              row[colIdx] = val;
            }
          }
        }
      }
      return row;
    }

    let leadSheetAction: string;
    let leadSheetRow: number | null = null;
    const duplicateLeadIdCount = matchIndices.length;
    let warning: string | null = null;

    if (matchIndices.length > 0) {
      // Update first match only
      const matchIdx = matchIndices[0];
      const sheetRowNum = matchIdx + 2; // dataRows[0] = sheet row 2
      const existingRow = dataRows[matchIdx] || [];
      const newRow = buildUpdateRow(existingRow);

      const updateResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(leadSheetName)}!A${sheetRowNum}:AN${sheetRowNum}?valueInputOption=RAW`,
        {
          method: "PUT",
          headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [newRow] })
        }
      );
      if (!updateResp.ok) {
        const errorText = await updateResp.text();
        return Response.json({ error: `Google Sheets API error (Lead Sheet update): ${errorText}` }, { status: 500 });
      }
      leadSheetAction = "updated";
      leadSheetRow = sheetRowNum;
      if (matchIndices.length > 1) {
        warning = `Duplicate Lead IDs found: ${matchIndices.length} rows match CRM Lead ID "${leadId}". Updated first match only (row ${sheetRowNum}).`;
      }
    } else {
      // Append new row
      const newRow = buildInsertRow();
      const appendResp = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(leadSheetName)}!A:A:append?insertDataOption=INSERT_ROWS&valueInputOption=RAW`,
        {
          method: "POST",
          headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ values: [newRow] })
        }
      );
      if (!appendResp.ok) {
        const errorText = await appendResp.text();
        return Response.json({ error: `Google Sheets API error (Lead Sheet append): ${errorText}` }, { status: 500 });
      }
      const appendResult = await appendResp.json();
      leadSheetAction = "inserted";
      const range = appendResult.updates?.updatedRange || "";
      const rowMatch = range.match(/A(\d+):/);
      leadSheetRow = rowMatch ? parseInt(rowMatch[1]) : null;
    }

    return Response.json({
      success: true,
      debriefAppended,
      leadSheetAction,
      leadSheetRow,
      leadId,
      duplicateLeadIdCount,
      warning
    });

  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}