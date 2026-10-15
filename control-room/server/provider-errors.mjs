// Only known gateway/preflight failures are permanent. Unknown errors and
// transport/provider interruptions retain the existing retryable 502 behavior.
const BAD_REQUEST = new Set([
  'Invalid Messages request',
  'Invalid Messages JSON',
  'Invalid max_tokens',
  'Invalid output limit or task budget',
  'Token count unavailable or context exceeds development limit'
]);
const POLICY = new Set([
  'Model has no verified spending policy',
  'Real inference requires a verified model budget policy',
  'Unverified remote MCP services are excluded from this budget',
  'Unverified remote containers are excluded from this budget',
  'Unverified remote/experimental services are excluded from this budget',
  'Paid server-side tools are excluded from this budget',
  'Spending ledger cannot be read; provider calls blocked'
]);

export function providerErrorResponse(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message === 'Spending reservation denied: shared or task budget would be exceeded') {
    return {status: 402, type: 'budget_error'};
  }
  if (BAD_REQUEST.has(message)) return {status: 400, type: 'invalid_request_error'};
  if (POLICY.has(message)) return {status: 403, type: 'permission_error'};
  // count_tokens failures are wrapped at the gateway, never inferred from
  // arbitrary provider text. Rate limits and server errors remain retryable.
  const preflight = /^Preflight HTTP (400|401|403|404|422): /.exec(message);
  if (preflight) {
    const denied = ['401', '403'].includes(preflight[1]);
    return {status: denied ? 403 : 400, type: denied ? 'permission_error' : 'invalid_request_error'};
  }
  return {status: 502, type: 'api_error'};
}
