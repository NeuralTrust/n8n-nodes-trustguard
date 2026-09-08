export const DEFAULT_API_BASE = 'https://trustguard.neuraltrust.ai';
export const EVALUATE_PATH = '/v1/evaluate';
export const DEFAULT_TIMEOUT_SECONDS = 5;
export const DEFAULT_MAX_RETRIES = 2;

// The type and the runtime set are derived from one tuple so they cannot drift.
const STATUSES = ['allow', 'ask', 'block', 'transform', 'report', 'skip'] as const;

// Typed as ReadonlySet<string> on purpose: the parser tests an arbitrary
// lowercased string against it.
export const KNOWN_STATUSES: ReadonlySet<string> = new Set(STATUSES);

export const UNREACHABLE_HTTP_STATUSES = new Set([502, 504]);
export const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 504]);
export const AUTH_HTTP_STATUSES = new Set([401, 403]);

export const TRANSFORM_MISSING = 'TrustGuard transform missing payload';
export const UNKNOWN_VERDICT = 'TrustGuard returned an unknown verdict';
export const UNREACHABLE = 'TrustGuard guardrail service unreachable';
export const AUTH_FAILED = 'TrustGuard authentication failed';
export const ENTITLEMENTS = 'TrustGuard entitlements unavailable';
export const REQUEST_FAILED = 'TrustGuard request failed';

// Parameter validation runs before anything is sent to TrustGuard, so neither
// of these carries the service name: what needs changing is in the node, and a
// "TrustGuard" prefix sends the user off to check a service that never saw the
// item.
export const TEXT_UNRESOLVED = 'The Text parameter did not resolve to any text to evaluate';
export const MESSAGES_UNUSABLE =
	'The Messages parameter did not resolve to a usable chat messages array';

// The reasons payload.ts can refuse an item, split by who can act on them.
// Closed unions so errors.ts can key a remedy table off them and the compiler
// refuses a new reason nobody has written a remedy for.
export type InputReason =
	| 'text_required'
	| 'messages_json'
	| 'messages_required'
	| 'message_shape'
	| 'role_missing';

export type TransformReason =
	| 'missing_payload'
	| 'message_count'
	| 'input_span'
	| 'message_shape'
	| 'role_missing'
	| 'role_mismatch'
	| 'content_type'
	| 'content_length'
	| 'content_part_type'
	| 'content_part_keys'
	| 'content_part_text'
	| 'not_text_coverable'
	| 'tool_calls_missing'
	| 'tool_call_count'
	| 'tool_call_shape'
	| 'tool_identity'
	| 'tool_name_mismatch'
	| 'tool_id_mismatch'
	| 'tool_args_json'
	| 'tool_args_type'
	| 'empty_transform';

export type TrustGuardStatus = (typeof STATUSES)[number];
export type EvaluateDirection = 'input' | 'output';

export type JsonObject = Record<string, unknown>;

export type ChatMessage = {
	role: string;
	content?: unknown;
	name?: string;
	tool_call_id?: string;
	tool_calls?: unknown[];
};

export type EvaluateBody = {
	payload: JsonObject;
	direction: EvaluateDirection;
	protocol: string;
	attributes: JsonObject;
	collector_key?: string;
	session_id?: string;
	consumer_id?: string;
};

export type TrustGuardVerdict = {
	status: TrustGuardStatus;
	traceId?: string;
	requestId?: string;
	findings?: unknown;
	transformedPayload?: JsonObject;
	raw: JsonObject;
};

export type HttpResponse = {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
};

export type Sender = () => Promise<HttpResponse>;
