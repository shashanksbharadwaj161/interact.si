// Standard, global direct-API receipt pricing. Verified 2026-10-14:
// https://platform.claude.com/docs/en/about-claude/pricing
export const PRICING_VERSION = 'anthropic-standard-global-2026-10-14-v1';
const RATES = {
 'claude-fable-5-1': {input:10, output:50, read:.25, five:12.5, hour:20, fallback:20},
 'claude-opus-5-5': {input:4, output:20, read:.2, five:5, hour:8, fallback:8},
 'claude-sonnet-5-5': {input:2, output:10, read:.1, five:2.5, hour:4, fallback:4},
 'claude-haiku-5-5': {input:.1, output:.5, read:.01, five:.125, hour:.2, fallback:1}
};
const validCount = n => Number.isSafeInteger(n) && n >= 0;

// Missing or inconsistent cache TTL breakdown retains the original conservative
// aggregate write rate. Missing/invalid core usage or unknown pricing modifiers
// cannot settle a reservation at all.
export function usageCost(model, usage, scope={serviceTier:'standard', inferenceGeo:'global'}) {
 if (!usage || typeof usage !== 'object' || !RATES[model]) return null;
 if (scope?.serviceTier !== 'standard' || scope?.inferenceGeo !== 'global') return null;
 if (usage.service_tier !== undefined && usage.service_tier !== 'standard') return null;
 if (usage.inference_geo !== undefined && usage.inference_geo !== 'global') return null;
 if (!validCount(usage.input_tokens) || !validCount(usage.output_tokens)) return null;
 const read = usage.cache_read_input_tokens === undefined ? 0 : usage.cache_read_input_tokens, write = usage.cache_creation_input_tokens === undefined ? 0 : usage.cache_creation_input_tokens;
 if (!validCount(read) || !validCount(write)) return null;
 const prompt = usage.input_tokens + read + write;
 if (!Number.isSafeInteger(prompt)) return null;
 const rates = model === 'claude-haiku-5-5' && prompt > 100000
   ? {input:.5, output:2.5, read:.05, five:.625, hour:1, fallback:1}
   : RATES[model];
 const split = usage.cache_creation;
 const five = split?.ephemeral_5m_input_tokens, hour = split?.ephemeral_1h_input_tokens;
 const validSplit = validCount(five) && validCount(hour) && five + hour === write;
 const cacheCost = validSplit ? five * rates.five + hour * rates.hour : write * rates.fallback;
 const cost = (usage.input_tokens * rates.input + usage.output_tokens * rates.output + read * rates.read + cacheCost) / 1e6;
 return Number.isFinite(cost) && cost >= 0 ? cost : null;
}
