// Business rules shared by the frontend and backend.
// Namespaced deliberately: several modules export the same names
// (TWO_LEG_DIVISIONS, APPOINTMENT_TYPE_HELP_TEXT), and a flat `export *`
// silently drops ambiguous re-exports rather than failing.
// Prefer the subpath import in application code: `@allied/shared/kpi`.
export * as appointmentClassification from "./appointmentClassification.js";
export * as appointmentMatching from "./appointmentMatching.js";
export * as appointmentTypes from "./appointmentTypes.js";
export * as constants from "./constants.js";
export * as insurance from "./insurance.js";
export * as kpi from "./kpi.js";
export * as marketingSources from "./marketingSources.js";
export * as salesAppointment from "./salesAppointment.js";
