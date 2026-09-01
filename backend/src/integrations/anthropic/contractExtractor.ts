/**
 * Contract document reading — classification and price extraction via the
 * Claude API's native PDF support (each page is read as both text and image,
 * so signatures and stamps are seen, not just the text layer).
 *
 * The prompt is built around three anchors verified on Allied's real
 * contracts (docs/, gitignored):
 *
 *   1. The contract total ALWAYS follows the sentence "We hereby propose to
 *      furnish material and labor complete in accordance with above
 *      specifications for the sum of:". Deposits and payment schedules put
 *      decoy amounts nearby; the anchor sentence disambiguates.
 *   2. The JOB NAME header field carries the JobProgress job number
 *      (e.g. 2608-8961835-01) — extracted so the caller can cross-check the
 *      document really belongs to the job being scanned.
 *   3. Change Orders and insurance paperwork also live in the Proposals tab
 *      and must never set the Job Price — they are classified, not extracted.
 *
 * Hand-rolled fetch rather than an SDK dependency, matching the JobProgress
 * client's style. One retry on transient failures; a malformed model reply is
 * an `unreadable` classification, never a throw — the scan must keep going.
 */

export interface ContractExtraction {
  classification: "retail_contract" | "change_order" | "insurance" | "other" | "unreadable";
  signed: boolean;
  amount: number | null;
  jobNumber: string | null;
  confidence: "high" | "low";
  notes: string;
  model: string;
  raw: unknown;
}

export interface ExtractorOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You read construction contract documents for Allied Construction & Remodeling and answer in strict JSON only.

The company's retail contract is a Leap-generated "PROPOSAL" (usually ~6 pages): a header block "PROPOSAL SUBMITTED TO" with customer details and a JOB NAME field, a scope-of-work list, and the total after the exact sentence "We hereby propose to furnish material and labor complete in accordance with above specifications for the sum of:". Client signature and date fields appear near the end.

Classify the document:
- "retail_contract": the proposal/contract described above, NOT insurance-related.
- "change_order": titled or clearly structured as a change order — its amount must never be reported as the contract total.
- "insurance": references an insurance claim, carrier, adjuster, deductible, claim number, or supplement.
- "other": anything else (estimates without the anchor sentence, permits, photos, worksheets).
- "unreadable": you cannot determine what it is.

For a retail_contract, extract:
- amount: the total following the anchor sentence, as a plain number (no $ or commas). Never a deposit, payment-schedule line, per-unit rate (like "$5/sqft"), or running balance. If the anchor sentence or its amount is missing, amount is null.
- job_number: the JOB NAME header value (format like 2608-8961835-01), else null.
- signed: true only if a client signature (mark, cursive name, or signed date on the client signature line) is visible.

confidence: "high" only when the anchor sentence was found with one unambiguous amount AND the document is clearly classified. Anything uncertain — smudged scans, multiple candidate totals, handwritten edits to the amount — is "low", explained in notes.

Reply with ONLY this JSON, no prose:
{"classification":"...","signed":true,"amount":12345.67,"job_number":"...","confidence":"high","notes":"..."}`;

/** Pulls the first JSON object out of a model reply, tolerating code fences. */
export function parseExtractionReply(text: string): Omit<ContractExtraction, "model" | "raw"> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const classification = String(parsed["classification"] ?? "");
    if (!["retail_contract", "change_order", "insurance", "other", "unreadable"].includes(classification)) {
      return null;
    }
    const amount = parsed["amount"];
    return {
      classification: classification as ContractExtraction["classification"],
      signed: parsed["signed"] === true,
      amount: typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : null,
      jobNumber: typeof parsed["job_number"] === "string" && parsed["job_number"].trim()
        ? parsed["job_number"].trim() : null,
      confidence: parsed["confidence"] === "high" ? "high" : "low",
      notes: String(parsed["notes"] ?? ""),
    };
  } catch {
    return null;
  }
}

export async function extractContractPrice(
  pdf: Buffer, options: ExtractorOptions = {},
): Promise<ContractExtraction> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const model = options.model ?? process.env.EXTRACTION_MODEL ?? "claude-sonnet-5";
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const body = JSON.stringify({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
        },
        { type: "text", text: "Classify this document and extract per your instructions. JSON only." },
      ],
    }],
  });

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2000);
    let res: Response;
    try {
      res = await fetchImpl(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body,
      });
    } catch (err) {
      lastError = `network: ${(err as Error).message}`;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Claude API HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const reply = await res.json() as { content?: { type: string; text?: string }[] };
    const text = (reply.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const parsed = parseExtractionReply(text);
    if (!parsed) {
      return {
        classification: "unreadable", signed: false, amount: null, jobNumber: null,
        confidence: "low", notes: `model reply was not parseable: ${text.slice(0, 200)}`,
        model, raw: reply,
      };
    }
    return { ...parsed, model, raw: reply };
  }
  throw new Error(`Claude API unavailable after retries (${lastError})`);
}
