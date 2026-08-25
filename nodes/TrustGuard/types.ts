export const DEFAULT_API_BASE = 'https://trustguard.neuraltrust.ai';
export const EVALUATE_PATH = '/v1/evaluate';
export const DEFAULT_TIMEOUT_SECONDS = 5;
export const DEFAULT_MAX_RETRIES = 2;

export const KNOWN_STATUSES = new Set(['allow', 'block', 'transform', 'report', 'skip']);

export const UNREACHABLE_HTTP_STATUSES = new Set([502, 504]);
export const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 504]);
export const AUTH_HTTP_STATUSES = new Set([401, 403]);

export const TRANSFORM_MISSING = 'TrustGuard transform missing payload';
export const UNKNOWN_VERDICT = 'TrustGuard returned an unknown verdict';
export const UNREACHABLE = 'TrustGuard guardrail service unreachable';
export const AUTH_FAILED = 'TrustGuard authentication failed';
export const ENTITLEMENTS = 'TrustGuard entitlements unavailable';
export const REQUEST_FAILED = 'TrustGuard request failed';

export type TrustGuardStatus = 'allow' | 'block' | 'transform' | 'report' | 'skip';
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
