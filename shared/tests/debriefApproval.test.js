import { describe, it, expect } from "vitest";
import { needsApproval, approvalStatus, isCounted, countedDebriefs, pendingApprovals, canApprove, APPROVAL_ROLES } from "../src/debriefApproval.js";
import { DQ_NO_DEMO_OUTCOME } from "../src/constants.js";

const dq = (over = {}) => ({ appointment_outcome: DQ_NO_DEMO_OUTCOME, dq_reason: "Renter", ...over });
const sale = { appointment_outcome: "Demo Completed — Sale", sale_amount: 12000 };

describe("debrief approval", () => {
  it("only the DQ / Do Not Reset outcome needs a manager", () => {
    expect(needsApproval(dq())).toBe(true);
    expect(needsApproval(sale)).toBe(false);
    expect(needsApproval({ appointment_outcome: "No Demo — Do Not Reset" })).toBe(false);
    expect(approvalStatus(sale)).toBeNull();
  });
  it("is pending until a manager acts, whatever the row says", () => {
    expect(approvalStatus(dq())).toBe("pending");
    expect(approvalStatus(dq({ approval_status: "garbage" }))).toBe("pending");
    expect(approvalStatus(dq({ approval_status: "approved" }))).toBe("approved");
    expect(approvalStatus(dq({ approval_status: "rejected" }))).toBe("rejected");
  });
  it("counts approved and ordinary debriefs; leaves pending and rejected out of results", () => {
    const rows = [sale, dq(), dq({ approval_status: "approved" }), dq({ approval_status: "rejected" })];
    expect(rows.map(isCounted)).toEqual([true, false, true, false]);
    expect(countedDebriefs(rows)).toHaveLength(2);
    expect(pendingApprovals(rows)).toBe(1);
    expect(countedDebriefs(null)).toEqual([]);
  });
  it("lets admins, sales managers and project managers approve", () => {
    expect(APPROVAL_ROLES).toEqual(["admin", "sales_manager", "project_manager"]);
    expect(canApprove("project_manager")).toBe(true);
    expect(canApprove("outside_sales_rep")).toBe(false);
    expect(canApprove("production")).toBe(false);
  });
});
