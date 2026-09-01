/**
 * HTTP transport for the backend API.
 *
 * Same-origin by design (MIGRATION_PLAN.md §10.1): the frontend is served from
 * `/` and the API from `/api` on one host, so there is no CORS configuration,
 * no preflight, and no cross-site cookie problem to get wrong.
 *
 * Authentication is a session cookie the browser attaches automatically. There
 * is no token in localStorage to read, which is the whole point (D18).
 */

// The server names this cookie `__Host-allied_csrf` in production (the __Host-
// prefix pins it to this origin over HTTPS) and `allied_csrf` in development,
// where Secure cookies cannot exist. Check the production name first.
const CSRF_COOKIES = ["__Host-allied_csrf", "allied_csrf"];
const CSRF_HEADER = "X-CSRF-Token";
const UNSAFE = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Reads the double-submit CSRF token the server set at login.
 *
 * Deliberately readable by JavaScript, unlike the session cookie: the client
 * has to echo it in a header. Knowing it proves nothing on its own, because a
 * cross-origin page cannot read cookies at all.
 */
export function csrfToken() {
  const cookies = document.cookie.split("; ");
  for (const name of CSRF_COOKIES) {
    const match = cookies.find((c) => c.startsWith(`${name}=`));
    if (match) return decodeURIComponent(match.slice(name.length + 1));
  }
  return null;
}

/** Called when the server reports the session is gone, so the app can react once. */
let onUnauthenticated = null;
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = fn;
}

export async function request(path, { method = "GET", body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE.has(method)) {
    const token = csrfToken();
    if (token) headers[CSRF_HEADER] = token;
  }

  const res = await fetch(path, {
    method,
    headers,
    // Cookies are the credential; without this the browser omits them.
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text.slice(0, 300) };
    }
  }

  if (!res.ok) {
    // A 401 anywhere means the session ended - expired, revoked, or the server
    // restarted. Surface it once rather than letting every query fail its own way.
    if (res.status === 401 && onUnauthenticated) onUnauthenticated();
    throw new ApiError(parsed?.error || `Request failed (${res.status})`, res.status, parsed);
  }
  return parsed;
}

export const get = (path, opts) => request(path, { ...opts, method: "GET" });
export const post = (path, body, opts) => request(path, { ...opts, method: "POST", body });
export const patch = (path, body, opts) => request(path, { ...opts, method: "PATCH", body });
export const del = (path, opts) => request(path, { ...opts, method: "DELETE" });

/** Encodes a query object, skipping empty values. */
export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
