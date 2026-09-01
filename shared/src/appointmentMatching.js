// Canonical appointment resolution + debrief dedupe shared by Submit Debrief and the partial-write audit.
// Base44 Appointment.id is the ONLY value allowed as the first arg to Appointment.update/get/delete.
// appointment_record_id, crm_lead_id, crm_job_id are external lookup keys — never used as internal ids.

const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase());

export function isValidId(id) {
  return id != null && String(id).trim() !== "" && String(id).trim().toLowerCase() !== "undefined";
}

export function resolveAppointmentForDebrief(debrief, appointments) {
  const list = appointments || [];
  const ok = (appointment, matchMethod) => ({
    status: "matched", appointment, appointmentId: appointment.id, matchMethod, warning: null,
  });
  const amb = (matchMethod, warning) => ({
    status: "ambiguous", appointment: null, appointmentId: null, matchMethod, warning,
  });

  // 1. appointment_record_id (external record id, when Appointments carry it)
  if (debrief.appointment_record_id) {
    const m = list.filter((a) => a.appointment_record_id && norm(a.appointment_record_id) === norm(debrief.appointment_record_id));
    if (m.length === 1) return ok(m[0], "Record ID");
    if (m.length > 1) return amb("Record ID", "Multiple appointments share this Record ID");
  }

  // 2. crm_lead_id + appointment_date + appointment_time
  if (debrief.crm_lead_id && debrief.appointment_date && debrief.appointment_time) {
    const m = list.filter((a) =>
      norm(a.crm_lead_id) === norm(debrief.crm_lead_id) &&
      a.appointment_date === debrief.appointment_date &&
      a.appointment_time && norm(a.appointment_time) === norm(debrief.appointment_time)
    );
    if (m.length === 1) return ok(m[0], "Lead ID + Date/Time");
    if (m.length > 1) return amb("Lead ID + Date/Time", "Multiple appointments match Lead ID + Date/Time");
  }

  // 3. fallback crm_lead_id + appointment_date (+ appointment_type where time is missing)
  if (debrief.crm_lead_id && debrief.appointment_date) {
    let m = list.filter((a) =>
      norm(a.crm_lead_id) === norm(debrief.crm_lead_id) &&
      a.appointment_date === debrief.appointment_date &&
      (!debrief.appointment_time || !a.appointment_time)
    );
    if (debrief.appointment_type) {
      const byType = m.filter((a) => norm(a.appointment_type) === norm(debrief.appointment_type));
      if (byType.length > 0) m = byType;
    }
    if (m.length === 1) return ok(m[0], "Lead ID + Date + Type");
    if (m.length > 1) return amb("Lead ID + Date + Type", "Multiple appointments match Lead ID + Date");
  }

  return { status: "unmatched", appointment: null, appointmentId: null, matchMethod: null, warning: "No appointment matched" };
}

export function findExistingDebrief(debrief, debriefs) {
  const list = debriefs || [];
  if (debrief.appointment_record_id) {
    const m = list.find((d) => d.appointment_record_id && norm(d.appointment_record_id) === norm(debrief.appointment_record_id));
    if (m) return m;
  }
  if (debrief.crm_lead_id && debrief.appointment_date) {
    const m = list.find((d) =>
      norm(d.crm_lead_id) === norm(debrief.crm_lead_id) &&
      d.appointment_date === debrief.appointment_date &&
      (!debrief.appointment_type || norm(d.appointment_type) === norm(debrief.appointment_type))
    );
    if (m) return m;
  }
  return null;
}