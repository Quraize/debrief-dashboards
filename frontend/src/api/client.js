/**
 * Compatibility client — the seam between the app and its backend.
 *
 * This exports the same object shape the pages already call (`list`, `filter`,
 * `get`, `create`, `update`, `delete`, `auth.*`, `functions.invoke`), but every
 * call now goes to our own Node API. Nothing Base44 remains inside it; the file
 * was renamed from `base44Client.js` in the same change that gutted it, so the
 * name and the contents stopped being Base44 together.
 *
 * Keeping the shape is what let 31 files and 84 call sites move backends
 * without being rewritten (MIGRATION_PLAN.md §4.1). It is transitional: as
 * pages are touched for other reasons, they should move to purpose-built
 * endpoints and this shrinks.
 *
 * ── The one behaviour that deliberately differs ──
 *
 * `list(sort, limit)` no longer honours `limit` as a hard cap. Every call site
 * passes 500, inherited from a Base44 platform limit, and that cap is why the
 * KPI numbers under-report today (§3.2): the dashboards aggregate in the
 * browser, so a truncated fetch silently produces a wrong figure rather than an
 * error. The shim now pages through to completion, so the aggregation sees
 * every row. §7.3 step two moves the heavy aggregates into SQL; this is step
 * one, and it restores correctness with no page changes.
 */
import { get, post, patch, del, qs, csrfToken, setUnauthenticatedHandler } from "./http.js";

/** Refuses to page forever if a filter is wrong or the dataset is unexpected. */
const MAX_ROWS = 50_000;
const PAGE_SIZE = 1000; // matches the server's MAX_PAGE_SIZE

/**
 * Fetches every page for a query and returns one flat array.
 * Pagination is an implementation detail the callers never see.
 */
async function fetchAll(entity, { sort, filter } = {}) {
  const rows = [];
  let offset = 0;

  for (;;) {
    const query = { ...(filter ?? {}), sort, limit: PAGE_SIZE, offset };
    const res = await get(`/api/entities/${entity}${qs(query)}`);
    rows.push(...res.data);

    if (!res.meta.hasMore) break;
    offset += res.data.length;

    if (res.data.length === 0) break; // defensive: never loop on an empty page
    if (rows.length >= MAX_ROWS) {
      console.warn(
        `[api] ${entity}: stopped at ${MAX_ROWS} rows. The dashboards aggregate in the ` +
        `browser, so this dataset now needs server-side aggregation (MIGRATION_PLAN.md §7.3).`,
      );
      break;
    }
  }
  return rows;
}

function entityApi(name) {
  return {
    /**
     * @param {string} [sort]  Base44-style: "-created_date" is descending.
     * @param {number} [_limit] Accepted for call-site compatibility; see the
     *   note above — the shim pages to completion so aggregates are correct.
     */
    list: (sort, _limit) => fetchAll(name, { sort }),

    /** Equality-only filtering, which is all any call site uses. */
    filter: (where, sort, _limit) => fetchAll(name, { sort, filter: where }),

    get: async (id) => (await get(`/api/entities/${name}/${encodeURIComponent(id)}`)).data,

    create: async (data) => (await post(`/api/entities/${name}`, data)).data,

    update: async (id, data) =>
      (await patch(`/api/entities/${name}/${encodeURIComponent(id)}`, data)).data,

    delete: async (id) => {
      await del(`/api/entities/${name}/${encodeURIComponent(id)}`);
      return { id };
    },
  };
}

/**
 * Entity handles are created on demand, so a name the backend does not know
 * fails at the request with a clear 404 rather than being silently undefined.
 */
const entities = new Proxy(/** @type {Record<string, ReturnType<typeof entityApi>>} */ ({}), {
  get: (cache, name) => {
    if (typeof name !== "string") return undefined;
    if (!cache[name]) cache[name] = entityApi(name);
    return cache[name];
  },
});

const auth = {
  /** Resolves to the user, or null when signed out — never throws for a 401. */
  me: async () => {
    try {
      return (await get("/api/auth/me")).user;
    } catch (err) {
      if (err.status === 401) return null;
      throw err;
    }
  },

  login: (email, password, totp) =>
    post("/api/auth/login", { email, password, ...(totp ? { totp } : {}) }),

  logout: async () => {
    try {
      await post("/api/auth/logout");
    } finally {
      // Land on the login page even if the request failed: the user asked to
      // leave, and a stuck session screen is worse than a redundant redirect.
      window.location.assign("/login");
    }
  },

  isAuthenticated: async () => (await auth.me()) !== null,

  redirectToLogin: (returnTo) => {
    // Never redirect to /login from /login. Without this guard the current URL
    // - which already carries a returnTo - gets encoded into a new returnTo on
    // every pass, and the app loops on a URL that doubles in length each time.
    if (window.location.pathname === "/login") return;
    const target = returnTo ?? window.location.pathname + window.location.search;
    // A returnTo pointing back at an auth page is meaningless; drop it.
    const safe = target.startsWith("/login") ? "/" : target;
    window.location.assign(`/login?returnTo=${encodeURIComponent(safe)}`);
  },

  totp: {
    begin: () => post("/api/auth/totp/begin"),
    confirm: (secret, code) => post("/api/auth/totp/confirm", { secret, code }),
  },

  // ── Self-service account management ──
  account: async () => (await get("/api/auth/account")).account,
  changePassword: (currentPassword, newPassword) =>
    post("/api/auth/password", { current_password: currentPassword, new_password: newPassword }),
  sessions: {
    list: async () => (await get("/api/auth/sessions")).sessions,
    revoke: (id) => del(`/api/auth/sessions/${encodeURIComponent(id)}`),
    revokeOthers: () => post("/api/auth/sessions/revoke-others"),
  },
};

/** Admin-only account administration. Every call is role-checked server-side. */
const admin = {
  users: {
    list: async () => (await get("/api/admin/users")).users,
    create: (data) => post("/api/admin/users", data),
    update: (id, changes) => patch(`/api/admin/users/${encodeURIComponent(id)}`, changes),
    unlock: (id) => post(`/api/admin/users/${encodeURIComponent(id)}/unlock`),
    resetPassword: (id, password) =>
      post(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, { password }),
    revokeSessions: (id) => post(`/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`),
  },
};

const functions = {
  /**
   * Kept returning `{ data }` because ImportAppointments and JobProgressSync
   * both read `response.data`. Changing it would be an invisible break.
   */
  invoke: async (name, body) => ({ data: await post(`/api/functions/${name}`, body ?? {}) }),
};

const integrations = {
  Core: {
    UploadFile: async ({ file }) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/files/upload", {
        method: "POST",
        credentials: "same-origin",
        headers: (() => {
          const token = csrfToken(); // handles the __Host- prefixed prod cookie
          return token ? { "X-CSRF-Token": token } : {};
        })(),
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      return res.json(); // { file_url }
    },
  },
};

export const api = { entities, auth, functions, integrations, admin };

/**
 * Legacy alias.
 *
 * Every call site still writes `base44.entities...`. Renaming 84 references is
 * a mechanical change, but doing it in the same commit that swaps the backend
 * would make the diff impossible to review: a genuine behavioural change would
 * hide among hundreds of identifier edits. The alias goes away in a follow-up
 * that changes nothing else.
 */
export const base44 = api;

export { setUnauthenticatedHandler };
export default api;
