/**
 * One Claude call: the next action for one sold job, in one sentence.
 *
 * The model is boxed in three ways. It is given the managers' standing
 * instructions and told to work inside them; it is given the job's facts and
 * the stage rule that already fired, and told not to invent anything beyond
 * them; and its reply is checked by validateSuggestion() — one sentence,
 * twenty words, names who acts — or thrown away. A malformed reply, a refusal
 * or an API failure is a `null` suggestion with the reason on `error`, never
 * a throw: the run must keep going and the rule stands in.
 *
 * Hand-rolled fetch, matching contractExtractor.ts. Cheap by design: Haiku
 * 4.5 by default, ~800 tokens in, ~60 out, one retry on 429/5xx.
 */
import { validateSuggestion } from "@allied/shared/nextAction";

const API_URL = "https://api.anthropic.com/v1/messages";
export const DEFAULT_NEXT_ACTION_MODEL = "claude-haiku-4-5";

export interface NextActionModelInput {
  /** The managers' standing instructions (ai_instruction / DEFAULT_INSTRUCTIONS). */
  instructions: string;
  /** suggestionFacts(row): the job as the model may know it. */
  facts: Record<string, unknown>;
}
export interface NextActionModelOptions {
  apiKey?: string; model?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number;
}
export interface NextActionModelResult {
  suggestion: string | null;
  confidence: "high" | "medium" | "low" | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Why there is no suggestion: refused, unparseable, HTTP n, network. */
  error: string | null;
}

/** Frozen framing — identical on every call, ahead of the managers' text, so it can cache. */
const FRAME = `You are a production coordinator's assistant at a roofing company. For ONE sold job you propose the single next action.

Work strictly inside the MANAGER INSTRUCTIONS that follow. They are policy; you apply them to the facts.
The facts include the rule the system already matched for this job's stage. Prefer it; sharpen it with the job's specifics (days waiting, missing price, a blocker the team wrote). Only depart from it when the instructions clearly call for something else.

Reply with JSON only, no prose, exactly this shape:
{"suggestion": "<one sentence, at most 20 words, starting with who does it>", "confidence": "high" | "medium" | "low"}

Never invent facts. Never propose cancelling the job or discussing price with the customer.`;

export async function suggestNextAction(input: NextActionModelInput, options: NextActionModelOptions = {}): Promise<NextActionModelResult> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = options.model ?? process.env.NEXT_ACTION_MODEL ?? DEFAULT_NEXT_ACTION_MODEL;
  const none = (error: string): NextActionModelResult => ({ suggestion: null, confidence: null, model, inputTokens: 0, outputTokens: 0, error });
  if (!apiKey) return none("ANTHROPIC_API_KEY is not set");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 20_000;

  const body = JSON.stringify({
    model,
    max_tokens: 200,
    system: [
      { type: "text", text: FRAME, cache_control: { type: "ephemeral" } },
      { type: "text", text: `MANAGER INSTRUCTIONS:\n${input.instructions.trim()}`, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: `JOB FACTS (JSON):\n${JSON.stringify(input.facts)}\n\nReply with the JSON object only.` }],
  });

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1500);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(API_URL, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body, signal: ctl.signal,
      });
    } catch (err) {
      lastError = `network: ${(err as Error).message}`;
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status >= 500) { lastError = `HTTP ${res.status}`; continue; }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return none(`HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const reply = await res.json() as {
      content?: { type: string; text?: string }[]; stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    const usage = reply.usage ?? {};
    const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const outputTokens = usage.output_tokens ?? 0;
    if (reply.stop_reason === "refusal") return { suggestion: null, confidence: null, model, inputTokens, outputTokens, error: "refused" };
    const text = (reply.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const checked = validateSuggestion(text) as { suggestion: string; confidence: "high" | "medium" | "low" } | null;
    if (!checked) return { suggestion: null, confidence: null, model, inputTokens, outputTokens, error: `unparseable: ${text.slice(0, 120)}` };
    return { suggestion: checked.suggestion, confidence: checked.confidence, model, inputTokens, outputTokens, error: null };
  }
  return none(lastError || "failed");
}
