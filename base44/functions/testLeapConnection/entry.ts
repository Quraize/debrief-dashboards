import { secrets } from "base44:runtime";
import { createClientFromRequest } from "npm:@base44/sdk@0.8.43";

const BASE = "https://api.jobprogress.com/api/v3";

function statusExplanation(status) {
  switch (status) {
    case 200: return "OK";
    case 401: return "Unauthorized — token missing or invalid";
    case 403: return "Forbidden — admin-only resource or insufficient permissions";
    case 404: return "Not Found — endpoint may not exist for this account";
    case 429: return "Too Many Requests — rate limit exceeded (60/min)";
    case 500: case 502: case 503: case 504: return `Server Error (${status}) — JobProgress side issue`;
    default: return status >= 500 ? `Server Error (${status})` : `HTTP ${status}`;
  }
}

async function probeEndpoint(name, url, token) {
  const result = { endpoint: name, url, status: null, success: false, topKeys: [], hasItems: false, explanation: "" };
  try {
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    });
    result.status = res.status;
    result.success = res.ok;
    if (!res.ok) {
      result.explanation = statusExplanation(res.status);
      return result;
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("json")) {
      result.topKeys = [`<non-json: ${contentType}>`];
      return result;
    }
    const body = await res.json();
    if (Array.isArray(body)) {
      result.topKeys = ["<array>"];
      result.hasItems = body.length > 0;
    } else if (body && typeof body === "object") {
      result.topKeys = Object.keys(body);
      const items = body.items || body.data || body.records || body.results || body.appointments;
      if (Array.isArray(items)) result.hasItems = items.length > 0;
    }
    result.explanation = "OK";
    return result;
  } catch (error) {
    result.explanation = `Fetch error: ${error.message}`;
    return result;
  }
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
    const secretPresent = !!token;

    if (!secretPresent) {
      return Response.json({
        secretPresent: false,
        jobs: { endpoint: "jobs", status: null, success: false, explanation: "Secret not configured" },
        appointments: { endpoint: "appointments", status: null, success: false, explanation: "Secret not configured" },
        authenticationValid: false,
        hasReadPermissions: false,
        blocker: "LEAP_API_TOKEN secret is not set — configure it in dashboard settings",
      });
    }

    const jobs = await probeEndpoint("jobs", `${BASE}/jobs?limit=1`, token);
    const appointments = await probeEndpoint("appointments", `${BASE}/appointments?limit=1`, token);

    const statuses = [jobs.status, appointments.status].filter((s) => s !== null);
    const anyAuthFailure = statuses.some((s) => s === 401 || s === 403);
    const anySuccess = statuses.some((s) => s >= 200 && s < 300);
    const authenticationValid = !anyAuthFailure && anySuccess;
    const hasReadPermissions = !statuses.some((s) => s === 403) && anySuccess;

    let blocker = null;
    if (statuses.some((s) => s === 401)) blocker = "Token rejected (401) — verify LEAP_API_TOKEN is valid and not expired";
    else if (statuses.some((s) => s === 403)) blocker = "Token lacks permissions (403) — admin role may be required";
    else if (statuses.every((s) => s === 404)) blocker = "Both endpoints returned 404 — verify API version or account access";

    return Response.json({
      secretPresent: true,
      jobs,
      appointments,
      authenticationValid,
      hasReadPermissions,
      blocker,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}