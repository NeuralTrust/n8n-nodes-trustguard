import { describe, expect, it, vi } from 'vitest';

import pkg from '../package.json';

import {
	TrustGuardAuthError,
	TrustGuardEntitlementError,
	TrustGuardRequestError,
	TrustGuardUnknownVerdictError,
	TrustGuardUnreachableError,
} from '../nodes/TrustGuard/errors';
import {
	blockText,
	evaluateWithSender,
	interpretResponse,
	mapTransportError,
	parseEvaluateResponse,
	retryDelayMs,
} from '../nodes/TrustGuard/transport';
import type { HttpResponse, Sender } from '../nodes/TrustGuard/types';
import { USER_AGENT } from '../nodes/TrustGuard/version';

function response(
	statusCode: number,
	body: unknown,
	headers: HttpResponse['headers'] = {},
): HttpResponse {
	return { statusCode, body, headers };
}

describe('parseEvaluateResponse', () => {
	it('lowercases a known status and keeps trace fields', () => {
		const verdict = parseEvaluateResponse({
			status: 'ALLOW',
			trace_id: 'tr-1',
			request_id: 'rq-1',
			findings: [],
		});
		expect(verdict.status).toBe('allow');
		expect(verdict.traceId).toBe('tr-1');
		expect(verdict.requestId).toBe('rq-1');
		expect(verdict.findings).toEqual([]);
	});

	it('accepts skip as a known status', () => {
		expect(parseEvaluateResponse({ status: 'skip' }).status).toBe('skip');
	});

	it('accepts ask as a known status rather than an unknown verdict', () => {
		expect(parseEvaluateResponse({ status: 'ask' }).status).toBe('ask');
		expect(parseEvaluateResponse({ status: 'ASK' }).status).toBe('ask');
	});
});

describe('blockText', () => {
	it('names the trace when there is one', () => {
		expect(blockText({ status: 'block', traceId: 'tr-9', raw: {} })).toBe(
			'Blocked by NeuralTrust TrustGuard. trace_id=tr-9',
		);
	});

	it('omits the trace when there is none', () => {
		expect(blockText({ status: 'block', raw: {} })).toBe('Blocked by NeuralTrust TrustGuard.');
	});

	// One wording for the whole Block output. In tool mode the model reads this,
	// so an ask must not read as a step the agent can resolve.
	it('describes ask exactly as it describes block', () => {
		expect(blockText({ status: 'ask', traceId: 'tr-9', raw: {} })).toBe(
			blockText({ status: 'block', traceId: 'tr-9', raw: {} }),
		);
	});

	it('treats a non-object transformed_payload as missing', () => {
		const verdict = parseEvaluateResponse({
			status: 'transform',
			transformed_payload: null,
		});
		expect(verdict.transformedPayload).toBeUndefined();
	});

	it('rejects a JSON array, missing status, and unknown status', () => {
		expect(() => parseEvaluateResponse(['allow'])).toThrow(TrustGuardUnknownVerdictError);
		expect(() => parseEvaluateResponse({ ok: true })).toThrow(TrustGuardUnknownVerdictError);
		expect(() => parseEvaluateResponse({ status: 'maybe' })).toThrow(
			TrustGuardUnknownVerdictError,
		);
	});
});

describe('interpretResponse', () => {
	it('maps auth, entitlements, unreachable, and other HTTP failures', () => {
		expect(() => interpretResponse(response(401, 'nope'))).toThrow(TrustGuardAuthError);
		expect(() => interpretResponse(response(403, 'nope'))).toThrow(TrustGuardAuthError);
		expect(() => interpretResponse(response(503, 'down'))).toThrow(TrustGuardEntitlementError);
		expect(() => interpretResponse(response(502, 'gw'))).toThrow(TrustGuardUnreachableError);
		expect(() => interpretResponse(response(504, 'gw'))).toThrow(TrustGuardUnreachableError);
		expect(() => interpretResponse(response(429, 'slow'))).toThrow(TrustGuardUnreachableError);
		expect(() => interpretResponse(response(400, 'bad'))).toThrow(TrustGuardRequestError);
		expect(() => interpretResponse(response(500, 'oops'))).toThrow(TrustGuardRequestError);
	});

	it('parses a JSON string body on HTTP 200', () => {
		const verdict = interpretResponse(response(200, '{"status":"report"}'));
		expect(verdict.status).toBe('report');
	});

	it('treats a non-JSON 200 as an unknown verdict', () => {
		expect(() => interpretResponse(response(200, 'not-json'))).toThrow(
			TrustGuardUnknownVerdictError,
		);
	});
});

describe('mapTransportError', () => {
	it('maps timeout and connect errors to unreachable', () => {
		expect(mapTransportError(new Error('connect ECONNREFUSED'))).toBeInstanceOf(
			TrustGuardUnreachableError,
		);
		expect(mapTransportError(new Error('request timeout'))).toBeInstanceOf(
			TrustGuardUnreachableError,
		);
	});

	it('maps TLS failures to a closed request error, not unreachable', () => {
		expect(mapTransportError(new Error('certificate verify failed SSL'))).toBeInstanceOf(
			TrustGuardRequestError,
		);
	});

	it('maps decode failures to an unknown verdict', () => {
		expect(mapTransportError(new Error('Failed to parse JSON'))).toBeInstanceOf(
			TrustGuardUnknownVerdictError,
		);
	});
});

// n8n does not hand a node the raw Node.js error. NodeApiError rewrites the
// message from COMMON_ERRORS, which strips the error code out of the text, and
// keeps the original only on the cause chain. Classifying on the message alone
// silently disables Fail Open on Unreachable for a service that is simply down.
// Shapes below were captured from n8n 2.35 against real failing endpoints.
function n8nError(message: string, code: string): Error {
	const axiosLike = Object.assign(new Error(`raw ${code}`), { code });
	return Object.assign(new Error(message, { cause: axiosLike }), { name: 'NodeApiError' });
}

describe('mapTransportError with n8n-wrapped errors', () => {
	it('treats a rewritten ECONNREFUSED as unreachable', () => {
		const error = n8nError('The service refused the connection - perhaps it is offline', 'ECONNREFUSED');
		expect(error.message).not.toContain('ECONNREFUSED');
		expect(mapTransportError(error)).toBeInstanceOf(TrustGuardUnreachableError);
	});

	it('treats a rewritten ENOTFOUND as unreachable', () => {
		const error = n8nError(
			'The connection cannot be established, this usually occurs due to an incorrect host (domain) value',
			'ENOTFOUND',
		);
		expect(error.message).not.toContain('ENOTFOUND');
		expect(mapTransportError(error)).toBeInstanceOf(TrustGuardUnreachableError);
	});

	it('treats a rewritten ETIMEDOUT as unreachable', () => {
		const error = n8nError(
			"The connection timed out, consider setting the 'Retry on Fail' option in the node settings",
			'ETIMEDOUT',
		);
		expect(mapTransportError(error)).toBeInstanceOf(TrustGuardUnreachableError);
	});

	it('keeps an EPROTO TLS handshake failure closed, not unreachable', () => {
		const error = n8nError(
			'write EPROTO ssl3_read_bytes:ssl/tls alert handshake failure:SSL alert number 40',
			'EPROTO',
		);
		expect(mapTransportError(error)).toBeInstanceOf(TrustGuardRequestError);
	});

	it('keeps a certificate error closed even when the chain also looks like a connect failure', () => {
		const error = n8nError('The service refused the connection', 'CERT_HAS_EXPIRED');
		expect(mapTransportError(error)).toBeInstanceOf(TrustGuardRequestError);
	});

	it('leaves an unrecognised failure closed', () => {
		expect(mapTransportError(new Error('something went sideways'))).toBeInstanceOf(
			TrustGuardRequestError,
		);
	});
});

describe('retryDelayMs', () => {
	it('prefers Retry-After and caps it at 5 seconds', () => {
		expect(retryDelayMs('1.5', 0)).toBe(1500);
		expect(retryDelayMs('30', 0)).toBe(5000);
	});

	it('uses exponential backoff capped at 2 seconds', () => {
		expect(retryDelayMs(undefined, 0)).toBe(250);
		expect(retryDelayMs(undefined, 1)).toBe(500);
		expect(retryDelayMs(undefined, 2)).toBe(1000);
		expect(retryDelayMs(undefined, 4)).toBe(2000);
	});
});

describe('evaluateWithSender', () => {
	it('retries 429 then succeeds', async () => {
		const send = vi
			.fn<Sender>()
			.mockResolvedValueOnce(response(429, 'slow'))
			.mockResolvedValueOnce(response(200, { status: 'allow' }));

		const verdict = await evaluateWithSender(send, { sleep: async () => undefined });
		expect(verdict.status).toBe('allow');
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('exhausts 429 retries and then fails as unreachable', async () => {
		const send = vi.fn<Sender>().mockResolvedValue(response(429, 'slow'));
		await expect(evaluateWithSender(send, { sleep: async () => undefined })).rejects.toBeInstanceOf(
			TrustGuardUnreachableError,
		);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it('retries a timeout then succeeds', async () => {
		const send = vi
			.fn<Sender>()
			.mockRejectedValueOnce(new Error('request timeout'))
			.mockResolvedValueOnce(response(200, { status: 'allow' }));
		const verdict = await evaluateWithSender(send, { sleep: async () => undefined });
		expect(verdict.status).toBe('allow');
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('does not retry 401', async () => {
		const send = vi.fn<Sender>().mockResolvedValue(response(401, 'nope'));
		await expect(evaluateWithSender(send, { sleep: async () => undefined })).rejects.toBeInstanceOf(
			TrustGuardAuthError,
		);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('does not retry 503', async () => {
		const send = vi.fn<Sender>().mockResolvedValue(response(503, 'down'));
		await expect(evaluateWithSender(send, { sleep: async () => undefined })).rejects.toBeInstanceOf(
			TrustGuardEntitlementError,
		);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('does not retry TLS failures', async () => {
		const send = vi.fn<Sender>().mockRejectedValue(new Error('SSL certificate verify failed'));
		await expect(evaluateWithSender(send, { sleep: async () => undefined })).rejects.toBeInstanceOf(
			TrustGuardRequestError,
		);
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe('user agent', () => {
	// version.ts is hand-maintained, so compare against package.json: a release
	// bump that forgets it must fail here rather than ship a wrong User-Agent.
	it('matches the package version', () => {
		expect(USER_AGENT).toBe(`n8n-neuraltrust/${pkg.version}`);
	});
});
