import type { INode } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, OperationalError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import {
	toNodeError,
	TrustGuardAuthError,
	TrustGuardEntitlementError,
	TrustGuardError,
	TrustGuardInputError,
	TrustGuardRequestError,
	TrustGuardTransformError,
	TrustGuardUnknownVerdictError,
	TrustGuardUnreachableError,
} from '../nodes/TrustGuard/errors';
import type { InputReason, TransformReason } from '../nodes/TrustGuard/types';
import {
	AUTH_FAILED,
	ENTITLEMENTS,
	MESSAGES_UNUSABLE,
	REQUEST_FAILED,
	TEXT_UNRESOLVED,
	TRANSFORM_MISSING,
	UNKNOWN_VERDICT,
	UNREACHABLE,
} from '../nodes/TrustGuard/types';

const NODE: INode = {
	id: 'test-node',
	name: 'TrustGuard',
	type: 'CUSTOM.neuralTrustTrustGuard',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const INPUT_REASONS: InputReason[] = [
	'text_required',
	'messages_json',
	'messages_required',
	'message_shape',
	'role_missing',
];

const TRANSFORM_REASON_LIST: TransformReason[] = [
	'missing_payload',
	'message_count',
	'input_span',
	'message_shape',
	'role_missing',
	'role_mismatch',
	'content_type',
	'content_length',
	'content_part_type',
	'content_part_keys',
	'content_part_text',
	'not_text_coverable',
	'tool_calls_missing',
	'tool_call_count',
	'tool_call_shape',
	'tool_identity',
	'tool_name_mismatch',
	'tool_id_mismatch',
	'tool_args_json',
	'tool_args_type',
	'empty_transform',
];

const ALL = [
	new TrustGuardUnreachableError(),
	new TrustGuardAuthError(),
	new TrustGuardEntitlementError(),
	new TrustGuardRequestError(),
	new TrustGuardUnknownVerdictError(),
	new TrustGuardTransformError('missing_payload'),
	new TrustGuardInputError('text_required'),
];

describe('error hierarchy', () => {
	// The assertion the n8n review turned on: every error this package raises
	// derives from an n8n class, not from a bare Error. A later refactor that
	// reparents onto Error fails here rather than in someone else's review.
	it('derives every error from n8n OperationalError', () => {
		for (const error of ALL) {
			expect(error).toBeInstanceOf(OperationalError);
			expect(error).toBeInstanceOf(TrustGuardError);
			expect(error).toBeInstanceOf(Error);
		}
	});

	it('gives every kind a distinct value', () => {
		const kinds = ALL.map((e) => e.kind);
		expect(new Set(kinds).size).toBe(kinds.length);
	});

	// json.error is set from the node error's message and is part of the
	// documented item contract, so these strings are pinned byte for byte.
	it('keeps the documented message on each error', () => {
		expect(new TrustGuardUnreachableError().message).toBe(UNREACHABLE);
		expect(new TrustGuardAuthError().message).toBe(AUTH_FAILED);
		expect(new TrustGuardEntitlementError().message).toBe(ENTITLEMENTS);
		expect(new TrustGuardRequestError().message).toBe(REQUEST_FAILED);
		expect(new TrustGuardUnknownVerdictError().message).toBe(UNKNOWN_VERDICT);
		expect(new TrustGuardTransformError('missing_payload').message).toBe(TRANSFORM_MISSING);
		expect(new TrustGuardInputError('text_required').message).toBe(TEXT_UNRESOLVED);
		expect(new TrustGuardInputError('messages_required').message).toBe(MESSAGES_UNUSABLE);
	});

	it('gives every error a description that is not just the message again', () => {
		for (const error of ALL) {
			expect(error.description).toBeTruthy();
			expect(error.description).not.toBe(error.message);
		}
	});

	it('carries the cause when the transport classified one', () => {
		const cause = new Error('socket hang up');
		expect(new TrustGuardUnreachableError(cause).cause).toBe(cause);
	});
});

describe('reason tables', () => {
	it('describes every input reason distinctly', () => {
		const seen = INPUT_REASONS.map((r) => new TrustGuardInputError(r).description);
		for (const d of seen) {
			expect(d).toBeTruthy();
		}
		expect(new Set(seen).size).toBe(INPUT_REASONS.length);
	});

	// The point of the change: twenty-one checks used to reach the user as the
	// same five words. Each now says what did not line up.
	it('describes every transform reason distinctly', () => {
		const seen = TRANSFORM_REASON_LIST.map((r) => new TrustGuardTransformError(r).description);
		for (const d of seen) {
			expect(d).toBeTruthy();
		}
		expect(new Set(seen).size).toBe(TRANSFORM_REASON_LIST.length);
	});

	it('keeps the reason readable on the error', () => {
		expect(new TrustGuardInputError('role_missing').reason).toBe('role_missing');
		expect(new TrustGuardTransformError('tool_args_json').reason).toBe('tool_args_json');
	});
});

describe('toNodeError', () => {
	it('sends service failures to NodeApiError with the item index', () => {
		for (const error of [
			new TrustGuardUnreachableError(),
			new TrustGuardAuthError(),
			new TrustGuardEntitlementError(),
			new TrustGuardRequestError(),
			new TrustGuardUnknownVerdictError(),
		]) {
			const mapped = toNodeError(NODE, error, 2);
			expect(mapped).toBeInstanceOf(NodeApiError);
			expect(mapped.context.itemIndex).toBe(2);
			expect(mapped.message).toBe(error.message);
			expect(mapped.description).toBe(error.description);
		}
	});

	it('sends input and transform failures to NodeOperationError with the item index', () => {
		for (const error of [
			new TrustGuardTransformError('missing_payload'),
			new TrustGuardInputError('text_required'),
		]) {
			const mapped = toNodeError(NODE, error, 5);
			expect(mapped).toBeInstanceOf(NodeOperationError);
			expect(mapped.context.itemIndex).toBe(5);
			expect(mapped.message).toBe(error.message);
			expect(mapped.description).toBe(error.description);
		}
	});

	// Both n8n constructors return their argument unchanged when handed one of
	// their own, so re-wrapping would silently drop the item index.
	it('passes an n8n error through by identity and stamps the item index', () => {
		const original = new NodeOperationError(NODE, 'credential is not decryptable');
		const mapped = toNodeError(NODE, original, 4);
		expect(mapped).toBe(original);
		expect(mapped.context.itemIndex).toBe(4);
	});

	it('does not overwrite an item index the n8n error already carries', () => {
		const original = new NodeApiError(NODE, { message: 'boom' }, { itemIndex: 1 });
		expect(toNodeError(NODE, original, 9).context.itemIndex).toBe(1);
	});

	it('treats anything else as a node defect and keeps the original as the cause', () => {
		const bug = new TypeError('x is not a function');
		const mapped = toNodeError(NODE, bug, 0);
		expect(mapped).toBeInstanceOf(NodeOperationError);
		expect(mapped.cause).toBe(bug);

		expect(toNodeError(NODE, 'a thrown string', 0)).toBeInstanceOf(NodeOperationError);
	});
});
