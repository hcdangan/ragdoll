/**
 * Deterministic input filtering and retrieved-text sanitisation.
 *
 * Ported from the FastAPI engine's `guardrails.py`. The hosted Guardrails AI
 * validators were deliberately not carried over: they require a model round trip
 * before the model round trip, which doubles the latency of a chat turn and makes a
 * blocked request depend on the provider being reachable at all. Pattern matching is
 * auditable, instant, and offline — the failure it accepts is a novel phrasing slipping
 * through, which the system prompt and the groundedness check still backstop.
 *
 * No function here calls a model, and none of them mutate their input.
 */

/** Verdict returned for one candidate input. */
export interface GuardrailVerdict {
  readonly blocked: boolean;
  readonly code: "jailbreak" | "prompt_injection" | null;
  readonly message: string;
  /** Source text of every pattern that fired, so a rejection can be explained. */
  readonly matched: readonly string[];
}

/**
 * Structural markers that only make sense inside a prompt template.
 *
 * Any of them in a user turn means the user is writing the prompt, not asking about the
 * documents, which is the definition of an injection attempt here. `{{ }}` is included
 * because this pipeline composes prompts with template braces, so an unbalanced pair in
 * the input can reach the template engine.
 */
export const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /<\s*\/?\s*(?:system|assistant|developer)\s*>/i,
  /^[ \t]*(?:system|assistant|developer)\s*:/im,
  /(?<![A-Za-z0-9_<])(?:system|assistant|developer)\s*:/im,
  /\bnew\s+(?:instructions?|system\s+prompt|rules?)\s*:/i,
  /\byour\s+new\s+(?:task|instructions?|role)\s+(?:is|are)\b/i,
  /\bapi[_-]?key\s*[:=]/i,
  /\b(?:secret|password|passphrase|token)\s*[:=]\s*["']?[A-Za-z0-9_\-+/.]{8,}/i,
  /\{\{|\}\}/,
];

/**
 * Overrides of the system prompt's authority.
 *
 * Patterns are anchored on the verb plus its object rather than on a single keyword:
 * `ignore` alone appears in ordinary questions ("why does the model ignore the last
 * instruction?"), so requiring the object keeps false positives out while still catching
 * the phrasings that actually attempt an override.
 */
export const JAILBREAK_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+|those\s+)*(?:previous|prior|above|earlier|preceding|initial|original|system)\s+(?:instructions?|prompts?|rules?|guidelines?|directions?)/i,
  /\bdisregard\s+(?:your|the)\s+(?:system\s+prompt|instructions?|guidelines?)/i,
  /\bdeveloper\s+mode\b/i,
  /\bDAN\s+mode\b/i,
  /\bjailbreak\s+mode\b/i,
  /\bdo\s+anything\s+now\b/i,
  /\bact\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|evil|unbounded)\b/i,
  /\bpretend\s+(?:that\s+)?(?:you\s+are|you\s+have|to\s+be|you\s+have\s+no)\b[^.!?\n]{0,40}?\b(?:no\s+rules?|no\s+restrictions?|no\s+filters?|no\s+limits?|unrestricted|unfiltered|uncensored)\b/i,
  /\bbypass\s+(?:your|the|any|all)\s+(?:safety|content|moderation)\s+(?:filters?|polic(?:y|ies)|guardrails?)\b/i,
  /\breveal\s+(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions?|initial\s+prompt)\b/i,
  /\bwithout\s+any\s+(?:ethical|moral|legal)\s+(?:limits?|restrictions?|constraints?)\b/i,
];

/** Exact rejection copy, mirrored by the `error.guardrail.*` dictionary entries. */
export const GUARDRAIL_MESSAGES = {
  jailbreak: "This request looks like a jailbreak attempt and was blocked.",
  injection: "This request looks like a prompt injection attempt and was blocked.",
} as const;

export class GuardrailError extends Error {
  readonly code: "guardrail_jailbreak" | "guardrail_injection";

  constructor(message: string, code: GuardrailError["code"]) {
    super(message);
    this.name = "GuardrailError";
    this.code = code;
  }
}

/**
 * Every pattern that matches `text`, in pattern-array order.
 * @param text Candidate input.
 * @param patterns Patterns to probe.
 */
const matchesOf = (text: string, patterns: readonly RegExp[]): string[] =>
  patterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);

/** Verdict for an input that no pattern fired on; built per call so callers can own it. */
const allowedVerdict = (): GuardrailVerdict => ({
  blocked: false,
  code: null,
  message: "",
  matched: [],
});

/**
 * Classifies one user turn before it reaches the model.
 *
 * Injection is checked first because a `<system>` tag is the stronger signal: a message
 * can contain both, and reporting the jailbreak would understate what arrived.
 * @param text Raw user input.
 */
export function scan(text: string): GuardrailVerdict {
  const injection = matchesOf(text, PROMPT_INJECTION_PATTERNS);
  if (injection.length > 0) {
    return {
      blocked: true,
      code: "prompt_injection",
      message: GUARDRAIL_MESSAGES.injection,
      matched: injection,
    };
  }
  const jailbreak = matchesOf(text, JAILBREAK_PATTERNS);
  if (jailbreak.length > 0) {
    return {
      blocked: true,
      code: "jailbreak",
      message: GUARDRAIL_MESSAGES.jailbreak,
      matched: jailbreak,
    };
  }
  return allowedVerdict();
}

/**
 * Rejects a blocked turn by throwing, for call sites that cannot branch on a verdict.
 *
 * `RAGDOLL_DISABLE_GUARDRAILS=1` is honoured so the guard can be switched off while
 * investigating a false positive in a live session, without a redeploy.
 * @param text Raw user input.
 */
export function enforce(text: string): void {
  if (process.env.RAGDOLL_DISABLE_GUARDRAILS === "1") {
    return;
  }
  const verdict = scan(text);
  if (!verdict.blocked) {
    return;
  }
  throw new GuardrailError(
    verdict.message,
    verdict.code === "jailbreak" ? "guardrail_jailbreak" : "guardrail_injection",
  );
}

/**
 * Tags a PDF can contain that would otherwise become prompt structure once injected.
 * Attributes are matched too: `<source id=7>` is a real extraction artefact, and
 * leaving it behind would still read as structure to the model.
 */
const RETRIEVED_TAG = /<\s*\/?\s*(?:system|assistant|developer|source)\b[^>]*>/gi;

/**
 * Neutralises role labels anywhere in the text.
 *
 * The lookbehind is load-bearing: without it `ecosystem:` matches `system:` and a
 * document about ecosystems comes back corrupted. `system:` at the very start of a line
 * still matches because a line start is not a word character.
 */
const RETRIEVED_ROLE_LABEL = /(?<![A-Za-z0-9_])(system|assistant|developer)\s*:/gi;

/**
 * Makes retrieved document text safe to place in a prompt.
 *
 * Retrieved text is data, never instructions, so every construct that could be read as
 * structure is rewritten rather than dropped: the surrounding sentence still reads
 * correctly for the model and for the citation panel. A label's original casing is kept
 * so the rewritten text still matches what the citation panel shows the reader.
 * @param text Raw text extracted from a PDF page.
 */
export function sanitiseRetrievedText(text: string): string {
  const neutralised = text
    .replace(RETRIEVED_TAG, " ")
    .replace(RETRIEVED_ROLE_LABEL, "[$1]:")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  return neutralised.trim();
}
