// Two-level marketing source structure: Category → exact source values.
// Single source of truth for the Marketing Source dropdown, category derivation,
// and historical alias mapping. Raw source values are never renamed — aliases
// are only used to derive the category at runtime.

export const MARKETING_CATEGORIES = [
  "Existing Customer / Referral",
  "Outbound / Rehash",
  "Outbound / Door Knocking & Walk-Up",
  "Networking",
  "Networx",
  "WebRunner",
  "Google / Search",
  "Social Media",
  "Lead Aggregators / Purchased Leads",
  "Website / Digital Properties",
  "Direct Mail / Offline Marketing",
  "Partner / Trade",
  "Self-Generated / Needs Detail",
  "Other / Needs Cleanup",
];

export const MARKETING_SOURCE_BY_CATEGORY = {
  "Existing Customer / Referral": [
    "! Repeat Client", "Customers", "Joe Mittiga Marketing Customer", "Existing Client Referral", "External Referral",
  ],
  "Outbound / Rehash": [
    "Cold Calling", "Rehash: Call or Drip Campaign", "Blast Boomerang Campaign Reload->New Lead/Existing Client",
    "Blast Boomerang Campaign: Re-Hash->Existing DNS Lead/Job", "E-Blast",
  ],
  "Outbound / Door Knocking & Walk-Up": [
    "Canvas Lead: Jason M.", "Canvas Lead: Pema", "Canvas Lead: Rob B.", "Canvas Leads: General",
    "Canvas Matt S.", "Door Hangers", "Job Walk Up", "Store Walk Up/ Storefront",
  ],
  "Networking": [
    "Christian's Network", "Jason's Network", "Joe C.'s Network or D2D", "Letip (Blank 1)", "Letip Blank 2",
    "Letip Blank 3", "Letip Blank 4", "Letip Blank 5", "Letip Clifton/Essex", "Letip Montvale (Christian)",
    "Letip Morris County", "Letip Paramus", "Letip Virutal Group", "Letip: Hackensack(Pema)", "Matt S. Network",
    "Networking General", "Pema's Network", "William's Network",
  ],
  "Networx": [
    "Networx Direct Calls", "Networx Exclusive Leads",
  ],
  "WebRunner": [
    "Google Paid - WR", "Bing Paid - WR", "WR - Facebook Paid", "WR - Siding", "WR - Unknown",
  ],
  "Google / Search": [
    "Google Organic Call In Lead", "Google LSA Call In/Msg/Form Fill Lead",
  ],
  "Social Media": [
    "Facebook CALL IN***", "Facebook LEAD FORM***", "Facebook MESSENGER***", "Facebook Town Groups", "Instagram",
  ],
  "Lead Aggregators / Purchased Leads": [
    "Angie's List", "Craft Jack", "Directorii (Roofing Insights)", "Guaranteed Estimates", "Hardie Lead",
    "Home Advisor", "Home Avengers", "Jared's Leads", "PMH", "Thumbtack",
  ],
  "Website / Digital Properties": [
    "Apex Chat/Website Chat Bot", "GAF Website", "Owens Corning Website", "Roofr Instant Estimate: Website Lead",
    "Website Contact Form", "BBB",
  ],
  "Direct Mail / Offline Marketing": [
    "Coupon Book Mailer: Advantage Printing", "Direct Mail Post Card", "Gazette Newspaper", "Money Mailer",
    "St. Andrews Church Paper", "Truck Wraps", "Yard Signs", "Street Fairs",
  ],
  "Partner / Trade": [
    "Atlas Roofing", "Hearth Financing",
  ],
  "Self-Generated / Needs Detail": [
    "Self-Gen / Other",
  ],
  "Other / Needs Cleanup": [
    "CHAT GBT", "Others", "Other / Needs Cleanup",
  ],
};

export const ALL_MARKETING_SOURCES = Object.values(MARKETING_SOURCE_BY_CATEGORY).flat();

// Reverse map: exact source → category (O(1) lookup)
const SOURCE_TO_CATEGORY = {};
Object.entries(MARKETING_SOURCE_BY_CATEGORY).forEach(([cat, sources]) => {
  sources.forEach((s) => { SOURCE_TO_CATEGORY[s] = cat; });
});

// Historical/legacy value → exact source label (for runtime category derivation only).
// Raw values are NEVER renamed — this map only resolves the category.
const SOURCE_ALIASES = {
  "Referral": "External Referral",
  "REPEAT CLIENT": "! Repeat Client",
  "Repeat Client": "! Repeat Client",
  "Existing Customer": "Customers",
  "Cold Call": "Cold Calling",
  "Outbound Cold Call": "Cold Calling",
  "READY MODE/COLD CALL": "Cold Calling",
  "ReadyMode Cold Call": "Cold Calling",
  "Door Knocking": "Canvas Leads: General",
  "JOB WALK UP": "Job Walk Up",
  "Yard Sign": "Yard Signs",
  "Truck Wraps": "Truck Wraps",
  "Networx": "Networx Direct Calls",
  "Networx Direct Call": "Networx Direct Calls",
  "WebRunner": "WR - Unknown",
  "WEBRUNNER GOOGLE PAID": "Google Paid - WR",
  "WEBRUNNER PAID-FORM": "WR - Facebook Paid",
  "Google Ads": "Google Paid - WR",
  "Google Organic": "Google Organic Call In Lead",
  "GOOGLE LSA": "Google LSA Call In/Msg/Form Fill Lead",
  "Organic Search": "Google Organic Call In Lead",
  "Facebook Ads": "Facebook CALL IN***",
  "Facebook Organic": "Facebook CALL IN***",
  "Angi": "Angie's List",
  "HomeAdvisor": "Home Advisor",
  "Apex Chat": "Apex Chat/Website Chat Bot",
  "Website": "Website Contact Form",
  "Website Contact Form": "Website Contact Form",
  "ROOFR INSTANT ESTIMATE": "Roofr Instant Estimate: Website Lead",
  "JASON'S SELF GEN": "Self-Gen / Other",
  "Self-Gen": "Self-Gen / Other",
  "Other": "Other / Needs Cleanup",
};

/**
 * Derive the Marketing Category from a raw marketing_source value.
 * 1. Exact match against the canonical source labels.
 * 2. Alias match (historical values → canonical label → category).
 * 3. Unmapped values → "Other / Needs Cleanup" (flagged for cleanup).
 * Never renames the raw value — only derives the category.
 */
export function getMarketingCategory(rawSource) {
  if (!rawSource || !String(rawSource).trim()) return "Other / Needs Cleanup";
  const v = String(rawSource).trim();
  if (SOURCE_TO_CATEGORY[v]) return SOURCE_TO_CATEGORY[v];
  const alias = SOURCE_ALIASES[v] || SOURCE_ALIASES[v.toLowerCase()];
  if (alias && SOURCE_TO_CATEGORY[alias]) return SOURCE_TO_CATEGORY[alias];
  return "Other / Needs Cleanup";
}

/**
 * Returns true if the raw source value is unmapped (will be flagged for cleanup).
 * Blank/empty values are also unmapped.
 */
export function isSelfGenNeedsDetail(rawSource) {
  return getMarketingCategory(rawSource) === "Self-Generated / Needs Detail";
}

export function isUnmappedSource(rawSource) {
  if (!rawSource || !String(rawSource).trim()) return true;
  const v = String(rawSource).trim();
  if (SOURCE_TO_CATEGORY[v]) return false;
  const alias = SOURCE_ALIASES[v] || SOURCE_ALIASES[v.toLowerCase()];
  if (alias && SOURCE_TO_CATEGORY[alias]) return false;
  return true;
}