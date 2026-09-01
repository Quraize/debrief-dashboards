# @allied/shared

Business rules shared by the frontend and the backend. **One copy, imported by both.**

This package exists because the same sales-classification rules previously lived in four
places that drifted apart — only 6 of 19 exclusion keywords agreed across them
(see `MIGRATION_PLAN.md` §2.1). Anything that both the UI and the API must agree on
belongs here, and nowhere else.

## The rule for what goes in here

A module belongs in `shared/` only if it is:

- **framework-free** — no React, no JSX, no hooks;
- **environment-free** — no `window`, `document`, `localStorage`, `import.meta.env`, no filesystem;
- **dependency-free** — these modules import nothing but each other. Keep it that way.

If it needs any of those, it belongs in `frontend/src/lib/` (browser) or `backend/src/` (server).

## Imports

Use the subpath form in application code:

```js
import { twoLegStats } from "@allied/shared/kpi";
import { classifyAppointment } from "@allied/shared/appointmentClassification";
```

The root barrel (`@allied/shared`) exports each module as a **namespace**, because several
modules export the same names (`TWO_LEG_DIVISIONS`, `APPOINTMENT_TYPE_HELP_TEXT`) and a flat
`export *` would silently drop the ambiguous ones.

**Relative imports inside this package must carry the `.js` extension.** Vite tolerates
extensionless imports; Node ESM does not, and the backend runs on Node.

## Tests

```bash
npm run test          # whole repo
npx vitest --project shared
```

`shared/` holds the logic that decides commission-relevant numbers, so it carries the
highest coverage expectation in the repo (§8.2 of the migration plan targets 90%).
