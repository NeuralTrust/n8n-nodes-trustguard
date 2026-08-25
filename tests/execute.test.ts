import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { NeuralTrustTrustGuard } from '../nodes/TrustGuard/NeuralTrustTrustGuard.node';

const NODE: INode = {
	id: 'test-node',
	name: 'TrustGuard',
	type: 'CUSTOM.neuralTrustTrustGuard',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

type Params = Record<string, unknown>;

function context(options: {
	params?: Params;
	items?: INodeExecutionData[];
	respond: () => unknown;
	continueOnFail?: boolean;
	asTool?: boolean;
}): IExecuteFunctions {
	const params: Params = {
		operation: 'evaluateInput',
		inputMode: 'text',
		text: 'hello',
		options: {},
		...options.params,
	};
	const items = options.items ?? [{ json: { chatInput: 'hello', keep: 'me' } }];

	return {
		getInputData: () => items,
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getCredentials: async () => ({ baseUrl: 'https://tg.example.test', collectorKey: '' }),
		getWorkflow: () => ({ id: 'wf-1', name: 'Test WF' }),
		getExecutionId: () => 'exec-1',
		getNode: () => (options.asTool ? { ...NODE, type: NODE.type + 'Tool' } : NODE),
		continueOnFail: () => options.continueOnFail ?? false,
		helpers: {
			httpRequestWithAuthentication: vi.fn(async () => options.respond()),
		},
	} as unknown as IExecuteFunctions;
}

const ok = (body: unknown) => () => ({ statusCode: 200, headers: {}, body });

async function run(ctx: IExecuteFunctions) {
	return (await NeuralTrustTrustGuard.prototype.execute.call(ctx)) as INodeExecutionData[][];
}

describe('verdict routing', () => {
	it.each([
		['allow', 0],
		['skip', 0],
		['report', 1],
		['block', 3],
	])('routes %s to output %i', async (status, index) => {
		const out = await run(context({ respond: ok({ status, trace_id: 't-1' }) }));
		expect(out[index]).toHaveLength(1);
		expect(out.flat()).toHaveLength(1);
		expect(out[index][0].json.trustguard).toMatchObject({ status, trace_id: 't-1' });
	});

	it('routes transform to output 2 and rewrites chatInput', async () => {
		const out = await run(
			context({
				respond: ok({
					status: 'transform',
					trace_id: 't-2',
					transformed_payload: { messages: [{ role: 'user', content: 'redacted' }] },
				}),
			}),
		);
		expect(out[2]).toHaveLength(1);
		expect(out[2][0].json.guardrailsInput).toBe('redacted');
		expect(out[2][0].json.chatInput).toBe('redacted');
		expect(out[2][0].json.keep).toBe('me');
	});
});

describe('failure routing', () => {
	// continueOnFail() is true for both On Error settings, but n8n only relocates
	// to the error output under continueErrorOutput. The item must therefore carry
	// `error` AND sit on a fail-closed output.
	it('routes a failed evaluation to Block carrying the error', async () => {
		const out = await run(
			context({
				continueOnFail: true,
				respond: () => ({ statusCode: 401, headers: {}, body: {} }),
			}),
		);

		expect(out[0]).toHaveLength(0);
		expect(out[3]).toHaveLength(1);
		const item = out[3][0];
		expect(item.error).toBeInstanceOf(NodeApiError);
		expect(item.json.error).toContain('authentication failed');
		expect(item.json.trustguard).toMatchObject({ status: 'error', evaluated: false });
		expect(item.json.keep).toBe('me');
	});

	it('throws a NodeApiError when continueOnFail is off', async () => {
		await expect(
			run(context({ respond: () => ({ statusCode: 401, headers: {}, body: {} }) })),
		).rejects.toBeInstanceOf(NodeApiError);
	});

	it('throws a NodeOperationError on an unusable transform', async () => {
		await expect(
			run(
				context({
					respond: ok({ status: 'transform', transformed_payload: { messages: [] } }),
				}),
			),
		).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('fail-open puts a clean item on Allow with no item error', async () => {
		const out = await run(
			context({
				params: { options: { failOpenOnUnreachable: true }, text: 'the real prompt' },
				respond: () => {
					throw new Error('connect ECONNREFUSED 127.0.0.1:9');
				},
			}),
		);

		expect(out[0]).toHaveLength(1);
		const item = out[0][0];
		expect(item.error).toBeUndefined();
		expect(item.json.guardrailsInput).toBe('the real prompt');
		expect(item.json.trustguard).toMatchObject({
			status: 'allow',
			unreachable: true,
			evaluated: false,
		});
	});

	it('never fails open on auth even when the option is on', async () => {
		await expect(
			run(
				context({
					params: { options: { failOpenOnUnreachable: true } },
					respond: () => ({ statusCode: 403, headers: {}, body: {} }),
				}),
			),
		).rejects.toBeInstanceOf(NodeApiError);
	});

	it('never fails open on a TLS error even when the option is on', async () => {
		await expect(
			run(
				context({
					params: { options: { failOpenOnUnreachable: true } },
					respond: () => {
						throw new Error('unable to verify the first certificate');
					},
				}),
			),
		).rejects.toBeInstanceOf(NodeApiError);
	});
});

describe('fail closed on unresolved input', () => {
	// A missing path resolves to undefined and getNodeParameter's fallback never
	// fires, so without this guard an empty payload would be scored `allow`.
	it.each([
		['undefined', undefined],
		['empty string', ''],
		['whitespace only', '   '],
		['a non-string', 42],
	])('refuses to evaluate when Text resolves to %s', async (_label, value) => {
		await expect(
			run(context({ params: { text: value }, respond: ok({ status: 'allow' }) })),
		).rejects.toBeInstanceOf(NodeOperationError);
	});

	it('still evaluates normal text', async () => {
		const out = await run(context({ params: { text: 'hello' }, respond: ok({ status: 'allow' }) }));
		expect(out[0]).toHaveLength(1);
	});
});

describe('messages mode', () => {
	const MESSAGES = [{ role: 'user', content: 'hi' }];

	it('accepts a real array', async () => {
		const out = await run(
			context({
				params: { inputMode: 'messages', messages: MESSAGES },
				respond: ok({ status: 'allow', trace_id: 't' }),
			}),
		);
		expect(out[0]).toHaveLength(1);
		expect(out[0][0].json.messages).toEqual(MESSAGES);
	});

	// n8n does not JSON-parse a `type: 'json'` parameter, so a literal array typed
	// into the field arrives as a string.
	it('accepts the literal JSON string n8n delivers', async () => {
		const out = await run(
			context({
				params: { inputMode: 'messages', messages: JSON.stringify(MESSAGES) },
				respond: ok({ status: 'allow', trace_id: 't' }),
			}),
		);
		expect(out[0]).toHaveLength(1);
		expect(out[0][0].json.messages).toEqual(MESSAGES);
	});

	it('still fails closed on malformed JSON', async () => {
		await expect(
			run(
				context({
					params: { inputMode: 'messages', messages: '[{"role":' },
					respond: ok({ status: 'allow' }),
				}),
			),
		).rejects.toBeInstanceOf(NodeOperationError);
	});
});


describe('as an AI Agent tool', () => {
	// n8n's tool wrapper reads only output index 0 (mapResult in n8n-core), so a
	// block routed to index 3 would reach the agent as an empty array.
	it.each([['block'], ['transform'], ['report']])(
		'returns a %s verdict on output 0 so the agent can see it',
		async (status) => {
			const out = await run(
				context({
					asTool: true,
					respond: ok({
						status,
						trace_id: 't',
						transformed_payload: { messages: [{ role: 'user', content: 'x' }] },
					}),
				}),
			);
			expect(out[0]).toHaveLength(1);
			expect(out[0][0].json.trustguard).toMatchObject({ status });
			expect(out[1].length + out[2].length + out[3].length).toBe(0);
		},
	);
});
