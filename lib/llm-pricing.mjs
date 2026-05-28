// Shadow-cost estimator: for calls that ran on a free/local backend (klick,
// ollama, …), compute what the same tokens would have cost on Anthropic.
// Lets us show a "saved $X" number — the value of the Mac Studio in dollars.
//
// Pricing pulled from Anthropic public list (2026-05-28). Sonnet 4.6 and
// Haiku 4.5 are what we use most. Cache reads/writes have their own rates
// but cached requests skip this path entirely (cache_status="hit" returns
// early), so we only model fresh-call cost.
//
// Methodology: the equivalent Anthropic cost for a klick call uses the
// model that would have served the same template/intent on Anthropic. The
// gateway passes the substituted model in `substitute_for` if known;
// otherwise we default to Sonnet (matches our default-model policy).

// USD per million tokens.
const PRICING = {
  sonnet: { input: 3.00,  output: 15.00, cache_read: 0.30, cache_write: 3.75 },
  haiku:  { input: 0.80,  output: 4.00,  cache_read: 0.08, cache_write: 1.00 },
  opus:   { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 18.75 },
};

const PER_MILLION = 1_000_000;

/**
 * Estimate what `usage` would have cost on the named Anthropic logical model.
 * Returns a small object — never throws on unknown model (just returns null).
 *
 * For reasoning backends like Qwen, `output_tokens` already includes the
 * reasoning chain. That's intentional — if you'd run this on Anthropic
 * extended-thinking, you'd pay for the thinking tokens too. The shadow
 * cost is therefore an honest upper bound, not a wishful undercount.
 */
export function shadowCostUSD(usage, substituteFor = "sonnet") {
  const tier = PRICING[substituteFor];
  if (!tier || !usage) return null;
  const input = (usage.input_tokens || 0) / PER_MILLION * tier.input;
  const output = (usage.output_tokens || 0) / PER_MILLION * tier.output;
  return {
    substitute_for: substituteFor,
    estimated_usd: round6(input + output),
    breakdown: {
      input_usd: round6(input),
      output_usd: round6(output),
    },
    pricing_source: "anthropic public list 2026-05-28",
  };
}

function round6(n) { return Math.round(n * 1_000_000) / 1_000_000; }

/**
 * Given the template name (if any) and the actual model that ran, infer
 * which Anthropic model the call would have used otherwise. Lets the
 * shadow cost match what the Anthropic equivalent would actually be.
 */
export function inferSubstituteModel(template, templates) {
  if (!template || !templates) return "sonnet";
  const tpl = templates[template];
  // Templates carry `model` = the Anthropic default they were calibrated for.
  return tpl?.model || "sonnet";
}
