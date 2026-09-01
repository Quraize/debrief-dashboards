#!/usr/bin/env bash
#
# Dumps the live Base44 entities to JSON, in the shape import-base44-export.ts expects.
#
#   1. npx base44 login          <- do this once, interactively; it opens a device-code flow
#   2. ./scripts/export-from-base44.sh ./export
#
# Why this rather than the app's own Export Center:
#
#   The Export Center runs buildExportRows(), which produces a DISPLAY export for
#   pasting into the master Google Sheet — 70 human-readable columns. It omits
#   two fields the KPI engine depends on:
#
#     * appointment_type   — isAppointmentOpportunity() and every two-leg figure
#                            key off it. Without it the Appointments count, the
#                            Two-Leg %, and the Demo Rate all collapse to zero.
#     * sale_signed_date   — drives effectiveSaleDate(), so signed-month sales
#                            attribution silently falls back to appointment month.
#
#   `base44 exec` runs server-side against the real entities, so it returns every
#   field. --privileged bypasses RLS, which is what makes a complete dump possible.
#
# This reads production data. It writes nothing back.
set -Eeuo pipefail

OUT="${1:-./export}"
mkdir -p "$OUT"

# Base44 caps list()/filter() at 5000 rows per request, so page explicitly rather
# than assuming one call is enough — the whole point of this export is completeness.
ENTITIES=(Appointment Debrief ListOption MarketingSource AppointmentImportExclusion SyncRun SyncConflict User)

for entity in "${ENTITIES[@]}"; do
  printf '  %-28s ' "$entity"
  script=$(cat <<EOF
const PAGE = 5000;
let all = [];
for (let skip = 0; ; skip += PAGE) {
  const page = await base44.entities.${entity}.list("-created_date", PAGE, skip);
  all = all.concat(page);
  if (page.length < PAGE) break;
}
console.log(JSON.stringify(all));
EOF
)
  if echo "$script" | npx base44 exec --privileged > "$OUT/${entity}.json" 2>/dev/null; then
    count=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$OUT/${entity}.json','utf8')).length)}catch{console.log('?')}")
    echo "${count} records"
  else
    echo "FAILED (entity may not exist, or you are not logged in)"
    rm -f "$OUT/${entity}.json"
  fi
done

echo
echo "Written to ${OUT}/"
echo
echo "This is production data containing customer names, phone numbers, emails and"
echo "addresses. Keep it outside the repository — ${OUT} should never be committed."
echo
echo "Next: DATABASE_URL=... npx tsx scripts/import-base44-export.ts ${OUT} --dry-run"
