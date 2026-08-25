import { describe, expect, it } from 'vitest';

import { TrustGuardTransformError } from '../nodes/TrustGuard/errors';
import {
	applyTransform,
	buildEvaluateBody,
	lastMessageText,
	messagesFromText,
	normalizeMessages,
} from '../nodes/TrustGuard/payload';
import type { ChatMessage } from '../nodes/TrustGuard/types';

describe('buildEvaluateBody', () => {
	it('builds the evaluate request body', () => {
		const body = buildEvaluateBody({
			messages: [{ role: 'user', content: 'hello' }],
			direction: 'input',
			modelName: 'gpt-4o-mini',
			collectorKey: 'tgcol_test',
			sessionId: 'sess-1',
		});

		expect(body).toEqual({
			payload: { messages: [{ role: 'user', content: 'hello' }] },
			direction: 'input',
			protocol: 'llm',
			attributes: {
				content_type: 'application/json',
				model: { name: 'gpt-4o-mini' },
			},
			collector_key: 'tgcol_test',
			session_id: 'sess-1',
		});
		expect(body).not.toHaveProperty('gateway_id');
	});

	it('omits collector and session when unbound', () => {
		const body = buildEvaluateBody({
			messages: [{ role: 'user', content: 'hello' }],
			direction: 'output',
		});
		expect(body).not.toHaveProperty('collector_key');
		expect(body).not.toHaveProperty('session_id');
		expect(body.attributes).toEqual({
			content_type: 'application/json',
			model: { name: '' },
		});
	});

	it('includes consumer_id and model.provider only when set', () => {
		const body = buildEvaluateBody({
			messages: [{ role: 'assistant', content: 'there' }],
			direction: 'output',
			modelProvider: 'openai',
			consumerId: 'user-1',
		});
		expect(body.consumer_id).toBe('user-1');
		expect(body.attributes.model).toEqual({ name: '', provider: 'openai' });
	});
});

describe('text helpers', () => {
	it('builds one user message for input text and one assistant message for output text', () => {
		expect(messagesFromText('hello', 'input')).toEqual([{ role: 'user', content: 'hello' }]);
		expect(messagesFromText('there', 'output')).toEqual([
			{ role: 'assistant', content: 'there' },
		]);
	});

	it('reads the last message text', () => {
		expect(
			lastMessageText([
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'there' },
			]),
		).toBe('there');
	});

	it('rejects a non-array or empty messages value', () => {
		expect(() => normalizeMessages([])).toThrow(TrustGuardTransformError);
		expect(() => normalizeMessages({})).toThrow(TrustGuardTransformError);
	});
});

describe('applyTransform', () => {
	it('rewrites a single text message', () => {
		const rewritten = applyTransform(
			[{ role: 'user', content: 'ssn 123-45-6789' }],
			{ messages: [{ role: 'user', content: 'ssn [REDACTED]' }] },
		);
		expect(rewritten[0].content).toBe('ssn [REDACTED]');
	});

	it('accepts a legacy input string on a single text-coverable message', () => {
		const rewritten = applyTransform([{ role: 'user', content: 'secret' }], {
			input: '[REDACTED]',
		});
		expect(rewritten[0].content).toBe('[REDACTED]');
	});

	it('redacts a single text block via input string', () => {
		const rewritten = applyTransform(
			[{ role: 'user', content: [{ type: 'text', text: 'secret' }] }],
			{ input: '[REDACTED]' },
		);
		expect(rewritten[0].content).toEqual([{ type: 'text', text: '[REDACTED]' }]);
	});

	it('fails on an input string for multiblock content', () => {
		expect(() =>
			applyTransform(
				[
					{
						role: 'user',
						content: [
							{ type: 'text', text: 'one' },
							{ type: 'text', text: 'two' },
						],
					},
				],
				{ input: '[REDACTED]' },
			),
		).toThrow(TrustGuardTransformError);
	});

	it('fails on an empty messages transform', () => {
		expect(() =>
			applyTransform([{ role: 'user', content: 'hi' }], { messages: [] }),
		).toThrow(TrustGuardTransformError);
	});

	it('fails when the transform is shorter than the span', () => {
		expect(() =>
			applyTransform(
				[
					{ role: 'user', content: 'a' },
					{ role: 'user', content: 'b' },
				],
				{ messages: [{ role: 'user', content: 'only' }] },
			),
		).toThrow(TrustGuardTransformError);
	});

	it('fails on a role mismatch', () => {
		expect(() =>
			applyTransform(
				[
					{ role: 'user', content: 'hi' },
					{ role: 'assistant', content: 'there' },
				],
				{
					messages: [
						{ role: 'assistant', content: 'shifted' },
						{ role: 'user', content: 'also shifted' },
					],
				},
			),
		).toThrow(TrustGuardTransformError);
	});

	it('fails on a role-only transform', () => {
		expect(() =>
			applyTransform([{ role: 'user', content: 'secret' }], {
				messages: [{ role: 'user' }],
			}),
		).toThrow(TrustGuardTransformError);
	});

	it('fails on a null content transform', () => {
		expect(() =>
			applyTransform([{ role: 'user', content: 'secret' }], {
				messages: [{ role: 'user', content: null }],
			}),
		).toThrow(TrustGuardTransformError);
	});

	it('fails when tool call count changes', () => {
		const original: ChatMessage = {
			role: 'assistant',
			content: '',
			tool_calls: [
				{ id: '1', type: 'function', function: { name: 'a', arguments: '{}' } },
				{ id: '2', type: 'function', function: { name: 'b', arguments: '{}' } },
			],
		};
		expect(() =>
			applyTransform([original], {
				messages: [
					{
						role: 'assistant',
						content: '',
						tool_calls: [
							{ id: '1', type: 'function', function: { name: 'a', arguments: '{}' } },
						],
					},
				],
			}),
		).toThrow(TrustGuardTransformError);
	});

	it('fails when tool calls are injected onto a message that had none', () => {
		expect(() =>
			applyTransform([{ role: 'assistant', content: 'hi' }], {
				messages: [
					{
						role: 'assistant',
						content: 'hi',
						tool_calls: [
							{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } },
						],
					},
				],
			}),
		).toThrow(TrustGuardTransformError);
	});

	it('rewrites tool-call arguments and keeps the original id', () => {
		const rewritten = applyTransform(
			[
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: 'c1',
							type: 'function',
							function: { name: 'search', arguments: '{"q":"ssn 1"}' },
						},
					],
				},
			],
			{
				messages: [
					{
						role: 'assistant',
						content: '',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'search', arguments: '{"q":"[REDACTED]"}' },
							},
						],
					},
				],
			},
		);
		expect(rewritten[0].tool_calls?.[0]).toMatchObject({
			id: 'c1',
			function: { name: 'search', arguments: '{"q":"[REDACTED]"}' },
		});
	});

	it('keeps the original tool-call id when the transform omits it', () => {
		const rewritten = applyTransform(
			[
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: 'c1',
							type: 'function',
							function: { name: 'search', arguments: '{"q":"ssn"}' },
						},
					],
				},
			],
			{
				messages: [
					{
						role: 'assistant',
						tool_calls: [
							{
								type: 'function',
								function: { name: 'search', arguments: '{"q":"[REDACTED]"}' },
							},
						],
					},
				],
			},
		);
		expect((rewritten[0].tool_calls?.[0] as { id: string }).id).toBe('c1');
	});

	it('fails on a tool name mismatch', () => {
		expect(() =>
			applyTransform(
				[
					{
						role: 'assistant',
						content: '',
						tool_calls: [
							{
								id: 'c1',
								type: 'function',
								function: { name: 'search', arguments: '{"q":"x"}' },
							},
						],
					},
				],
				{
					messages: [
						{
							role: 'assistant',
							tool_calls: [
								{
									id: 'c1',
									type: 'function',
									function: { name: 'other', arguments: '{"q":"x"}' },
								},
							],
						},
					],
				},
			),
		).toThrow(TrustGuardTransformError);
	});
});
