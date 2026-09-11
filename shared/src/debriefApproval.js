// Manager approval of "No Demo — DQ / Do Not Reset" debriefs.
//
// A rep who disqualifies a lead instead of resetting it takes that opportunity
// off the board, so a manager confirms each one. The debrief exists from the
// moment it is filed (it closes the Open Debrief Queue item), but the results
// pages count it only once approved.

import { DQ_NO_DEMO_OUTCOME } from "./constants.js";

/** Who may approve or reject. Mirrors the server's role check. */
export const APPROVAL_ROLES = ["admin", "sales_manager", "project_manager"];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"];
export const APPROVAL_LABELS = { pending: "Awaiting approval", approved: "Approved", rejected: "Rejected" };

/** True for a debrief whose outcome needs a manager's sign-off. */
export const needsApproval = (d) => String(d?.appointment_outcome ?? "") === DQ_NO_DEMO_OUTCOME;

/** The status a debrief effectively has: pending until a manager acts, null when no approval is needed. */
export function approvalStatus(d) {
  if (!needsApproval(d)) return null;
  return APPROVAL_STATUSES.includes(d.approval_status) ? d.approval_status : "pending";
}

/** True when the debrief counts in results: no approval needed, or approved. */
export const isCounted = (d) => approvalStatus(d) !== "pending" && approvalStatus(d) !== "rejected";

/** The debriefs the dashboards and Results Review should see. */
export const countedDebriefs = (debriefs) => (debriefs ?? []).filter(isCounted);

/** How many are waiting on a manager, for badges. */
export const pendingApprovals = (debriefs) => (debriefs ?? []).filter((d) => approvalStatus(d) === "pending").length;

export const canApprove = (role) => APPROVAL_ROLES.includes(role);
