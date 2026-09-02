import type { IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

import {
	TrustGuardAuthError,
	TrustGuardEntitlementError,
	TrustGuardRequestError,
	TrustGuardUnknownVerdictError,
	TrustGuardUnreachableError,
} from './errors';
import {
	AUTH_HTTP_STATUSES,
	DEFAULT_MAX_RETRIES,
	EVALUATE_PATH,
	KNOWN_STATUSES,
	RETRYABLE_HTTP_STATUSES,
	UNREACHABLE_HTTP_STATUSES,
	type EvaluateBody,
	type HttpResponse,
	type JsonObject,
	type Sender,
	type TrustGuardStatus,
	type TrustGuardVerdict,
} from './types';
import { USER_AGENT } from './version';

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function headerValue(
	headers: HttpResponse['headers'],
	name: string,
): string | undefined {
	const match = Object.entries(headers).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	);
	if (!match) {
		return undefined;
	}
	const value = match[1];
	return Array.isArray(value) ? value[0] : value;
}

export function retryDelayMs(retryAfter: string | undefined, attempt: number): number {
	if (retryAfter) {
		const parsed = Number(retryAfter);
		if (Number.isFinite(parsed) && parsed >= 0) {
			return Math.min(parsed, 5) * 1000;
		}
	}
	const backoff = 0.25 * 2 ** attempt;
	return Math.min(backoff, 2) * 1000;
}

export function parseEvaluateResponse(body: unknown): TrustGuardVerdict {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new TrustGuardUnknownVerdictError();
	}
	const parsed = body as JsonObject;
	const status = parsed.status;
	if (typeof status !== 'string' || !KNOWN_STATUSES.has(status.toLowerCase())) {
		throw new TrustGuardUnknownVerdictError();
	}
	const transformed = parsed.transformed_payload;
	return {
		status: status.toLowerCase() as TrustGuardStatus,
		traceId: optionalString(parsed.trace_id),
		requestId: optionalString(parsed.request_id),
		findings: parsed.findings,
		transformedPayload:
			transformed && typeof transformed === 'object' && !Array.isArray(transformed)
				? (transformed as JsonObject)
				: undefined,
		raw: parsed,
	};
}

export function mapStatusCode(statusCode: number): never | void {
	if (AUTH_HTTP_STATUSES.has(statusCode)) {
		throw new TrustGuardAuthError();
	}
	if (statusCode === 503) {
		throw new TrustGuardEntitlementError();
	}
	if (UNREACHABLE_HTTP_STATUSES.has(statusCode) || statusCode === 429) {
		throw new TrustGuardUnreachableError();
	}
	if (statusCode < 200 || statusCode >= 300) {
		throw new TrustGuardRequestError();
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function interpretResponse(response: HttpResponse): TrustGuardVerdict {
	mapStatusCode(response.statusCode);
	let body = response.body;
	if (typeof body === 'string') {
		const parsed = parseJson(body);
		if (parsed === undefined) {
			throw new TrustGuardUnknownVerdictError();
		}
		body = parsed;
	}
	return parseEvaluateResponse(body);
}

const MAX_CAUSE_DEPTH = 6;

const UNREACHABLE_ERROR_CODES = new Set([
	'ECONNABORTED',
	'ECONNREFUSED',
	'ECONNRESET',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETDOWN',
	'ENETUNREACH',
	'ENOTFOUND',
	'EPIPE',
	'ESOCKETTIMEDOUT',
	'ETIMEDOUT',
]);

// n8n replaces Node.js error codes with prose before a node ever sees the error
// (see COMMON_ERRORS in n8n-workflow). Matching only on the raw code would miss
// every real "service is down" case and silently disable fail-open.
const UNREACHABLE_PHRASES = [
	'refused the connection',
	'connection cannot be established',
	'connection timed out',
	'connection to the server was closed unexpectedly',
	'connection was aborted',
	'host is unreachable',
	'dns server returned an error',
	'closed the connection unexpectedly',
	'timeout',
	'network',
];

// Raw error codes also appear in the message text, not only on the object.
const UNREACHABLE_CODE_TEXT = [...UNREACHABLE_ERROR_CODES].map((code) => code.toLowerCase());

const TLS_ERROR_CODES = new Set([
	'CERT_HAS_EXPIRED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth++) {
		chain.push(current);
		current = (current as { cause?: unknown }).cause;
	}
	return chain;
}

export function errorCodes(error: unknown): string[] {
	return causeChain(error)
		.map((link) => (link as { code?: unknown }).code)
		.filter((code): code is string => typeof code === 'string')
		.map((code) => code.toUpperCase());
}

function errorText(error: unknown): string {
	const chain = causeChain(error);
	if (!chain.length) {
		return String(error).toLowerCase();
	}
	return chain
		.map((link) =>
			link instanceof Error ? `${link.name} ${link.message}` : String(link),
		)
		.join(' ')
		.toLowerCase();
}

function isTlsFailure(codes: string[], text: string): boolean {
	if (
		codes.some(
			(code) =>
				TLS_ERROR_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('ERR_TLS'),
		)
	) {
		return true;
	}
	return (
		text.includes('ssl') ||
		text.includes('tls') ||
		text.includes('certificate') ||
		text.includes('cert_')
	);
}

export function mapTransportError(error: unknown): Error {
	if (
		error instanceof TrustGuardUnreachableError ||
		error instanceof TrustGuardAuthError ||
		error instanceof TrustGuardEntitlementError ||
		error instanceof TrustGuardRequestError ||
		error instanceof TrustGuardUnknownVerdictError
	) {
		return error;
	}

	const codes = errorCodes(error);
	const text = errorText(error);

	// Checked first: a certificate failure can read like a connection failure, and
	// a possible MITM must never be downgraded to a transient blip.
	if (isTlsFailure(codes, text)) {
		return new TrustGuardRequestError();
	}

	if (
		codes.some((code) => UNREACHABLE_ERROR_CODES.has(code)) ||
		UNREACHABLE_CODE_TEXT.some((code) => text.includes(code)) ||
		UNREACHABLE_PHRASES.some((phrase) => text.includes(phrase))
	) {
		return new TrustGuardUnreachableError();
	}

	if (text.includes('json') || text.includes('decode') || text.includes('parse')) {
		return new TrustGuardUnknownVerdictError();
	}
	return new TrustGuardRequestError();
}

export async function evaluateWithSender(
	send: Sender,
	options: {
		maxRetries?: number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<TrustGuardVerdict> {
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const wait = options.sleep ?? sleep;
	const attempts = maxRetries + 1;

	let lastUnreachable: TrustGuardUnreachableError | undefined;
	let lastResponse: HttpResponse | undefined;

	for (let attempt = 0; attempt < attempts; attempt++) {
		let response: HttpResponse;
		try {
			response = await send();
		} catch (error) {
			const mapped = mapTransportError(error);
			if (mapped instanceof TrustGuardUnreachableError && attempt < maxRetries) {
				lastUnreachable = mapped;
				await wait(retryDelayMs(undefined, attempt));
				continue;
			}
			throw mapped;
		}

		lastResponse = response;
		if (RETRYABLE_HTTP_STATUSES.has(response.statusCode) && attempt < maxRetries) {
			await wait(retryDelayMs(headerValue(response.headers, 'retry-after'), attempt));
			continue;
		}
		return interpretResponse(response);
	}

	if (lastResponse) {
		return interpretResponse(lastResponse);
	}
	throw lastUnreachable ?? new TrustGuardUnreachableError();
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function createN8nSender(
	ctx: IExecuteFunctions,
	options: {
		baseUrl: string;
		body: EvaluateBody;
		timeoutSeconds: number;
	},
): Sender {
	const url = `${options.baseUrl.replace(/\/+$/, '')}${EVALUATE_PATH}`;
	return async () => {
		const request: IHttpRequestOptions = {
			method: 'POST',
			url,
			body: options.body,
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				'User-Agent': USER_AGENT,
			},
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: Math.round(options.timeoutSeconds * 1000),
		};

		const raw = await ctx.helpers.httpRequestWithAuthentication.call(
			ctx,
			'trustGuardApi',
			request,
		);
		const record = asRecord(raw);
		const statusCode =
			typeof record.statusCode === 'number'
				? record.statusCode
				: typeof record.status === 'number'
					? record.status
					: 200;
		const headers = asRecord(record.headers) as HttpResponse['headers'];
		return {
			statusCode,
			headers,
			body: 'body' in record ? record.body : raw,
		};
	};
}

// One message for everything on the Block output. `ask` lands there too and
// deliberately reads the same: in AI-tool mode this string is what the model
// receives, and wording it as a pending confirmation would invite an agent to
// treat a denial as something it can resolve. The distinction stays on
// `trustguard.status`, where a workflow can branch on it.
export function blockText(verdict: TrustGuardVerdict): string {
	if (verdict.traceId) {
		return `Blocked by NeuralTrust TrustGuard. trace_id=${verdict.traceId}`;
	}
	return 'Blocked by NeuralTrust TrustGuard.';
}
