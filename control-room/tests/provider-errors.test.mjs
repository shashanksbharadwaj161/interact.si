import test from 'node:test';
import assert from 'node:assert/strict';
import {providerErrorResponse} from '../server/provider-errors.mjs';
import {routeRequest} from '../server/gateway-policy.mjs';

const classified = message => providerErrorResponse(new Error(message));
test('reservation denials cannot trigger provider SDK retry loops', () => {
  assert.deepEqual(classified('Spending reservation denied: shared or task budget would be exceeded'), {status: 402, type: 'budget_error'});
});
test('context and schema failures are nonretryable client failures', () => {
  for (const message of ['Token count unavailable or context exceeds development limit', 'Invalid Messages JSON', 'Invalid output limit or task budget']) {
    assert.equal(classified(message).status, 400);
  }
  try {routeRequest({max_tokens: 0}, {model: 'claude-opus-5-5'});assert.fail('Expected policy rejection');}
  catch (error) {assert.equal(providerErrorResponse(error).status, 400);}
});
test('known remote tools and unverified model policies are forbidden', () => {
  for (const input of [{tools: [{type: 'web_search_20250305'}]}, {container: 'remote'}, {mcp_servers: [{}]}]) {
    try {routeRequest(input, {model: 'claude-opus-5-5'});assert.fail('Expected policy rejection');}
    catch (error) {assert.equal(providerErrorResponse(error).status, 403);}
  }
  assert.equal(classified('Real inference requires a verified model budget policy').status, 403);
});
test('permanent preflight failures are nonretryable; outages remain retryable', () => {
  for (const status of [400, 404, 422]) assert.equal(classified(`Preflight HTTP ${status}: invalid payload`).status, 400);
  for (const status of [401, 403]) assert.equal(classified(`Preflight HTTP ${status}: denied`).status, 403);
  for (const message of ['fetch failed', 'ECONNRESET', 'Preflight HTTP 429: rate limit', 'Preflight HTTP 500: overloaded', 'Preflight HTTP 503: service unavailable', 'Provider event exceeded supported size']) {
    assert.deepEqual(classified(message), {status: 502, type: 'api_error'});
  }
});
test('arbitrary error text cannot masquerade as an exact policy failure', () => {
  assert.equal(classified('Network failed after Invalid max_tokens').status, 502);
  assert.equal(classified('Server responded: Spending reservation denied: shared or task budget would be exceeded').status, 502);
  assert.equal(providerErrorResponse({}).status, 502);
});
