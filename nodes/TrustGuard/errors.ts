import type { INode, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError, OperationalError } from 'n8n-workflow';

import type { InputReason, TransformReason } from './types';
import {
	AUTH_FAILED,
	ENTITLEMENTS,
	MESSAGES_UNUSABLE,
	REQUEST_FAILED,
	TEXT_UNRESOLVED,
	TRANSFORM_MISSING,
	UNKNOWN_VERDICT,
	UNREACHABLE,
} from './types';

// Errors in this package derive from n8n's OperationalError and reach n8n as a
// NodeApiError or a NodeOperationError, built by toNodeError at the bottom of
// this file.
//
// Why two steps rather than constructing the node errors where they are thrown:
// NodeApiError and NodeOperationError cannot be built without an INode, and the
// modules that classify failures - transport.ts (retries, status mapping,
// cause-chain classification) and payload.ts (parameter and transform
// verification) - are deliberately node-agnostic and unit-tested with a fake
// sender and no execution context. OperationalError is n8n's own base for
// exactly this kind of in-node failure, so the n8n semantics are on the object
// from the moment it is thrown, and toNodeError only binds it to the node and
// the item it belongs to.

export type TrustGuardErrorKind =
	| 'unreachable'
	| 'auth'
	| 'entitlement'
	| 'request'
	| 'unknownVerdict'
	| 'transform'
	| 'input';

export abstract class TrustGuardError extends OperationalError {
	abstract readonly kind: TrustGuardErrorKind;

	// description is required, not optional: n8n renders it as the "how to get
	// unstuck" half of an error, and both node error classes lift it off the
	// error they wrap. Before this every error this node emitted had an empty
	// description, so the user was told what happened and never what to do next.
	protected constructor(message: string, description: string, cause?: unknown) {
		super(message, { description, cause });
	}
}

export class TrustGuardUnreachableError extends TrustGuardError {
	readonly kind = 'unreachable';

	constructor(cause?: unknown) {
		super(
			UNREACHABLE,
			'Check that the base URL in the TrustGuard credential is reachable from this n8n instance, and raise Timeout (Seconds) if the service is slow. Turn on Fail Open on Unreachable in Options only if traffic should keep flowing unscanned while TrustGuard is down.',
			cause,
		);
		this.name = 'TrustGuardUnreachableError';
	}
}

export class TrustGuardAuthError extends TrustGuardError {
	readonly kind = 'auth';

	constructor(cause?: unknown) {
		super(
			AUTH_FAILED,
			'Open the TrustGuard credential and check the API key is current and scoped to this workspace, then run the node again.',
			cause,
		);
		this.name = 'TrustGuardAuthError';
	}
}

export class TrustGuardEntitlementError extends TrustGuardError {
	readonly kind = 'entitlement';

	constructor(cause?: unknown) {
		super(
			ENTITLEMENTS,
			'This workspace has no active TrustGuard entitlement covering the collector. Check the plan in the NeuralTrust console, then run the node again.',
			cause,
		);
		this.name = 'TrustGuardEntitlementError';
	}
}

export class TrustGuardRequestError extends TrustGuardError {
	readonly kind = 'request';

	constructor(cause?: unknown) {
		super(
			REQUEST_FAILED,
			'Check that the base URL in the TrustGuard credential points at a TrustGuard deployment and that no proxy is rewriting the request. A certificate that cannot be verified also lands here, and is deliberately never treated as a transient outage.',
			cause,
		);
		this.name = 'TrustGuardRequestError';
	}
}

export class TrustGuardUnknownVerdictError extends TrustGuardError {
	readonly kind = 'unknownVerdict';

	constructor(cause?: unknown) {
		super(
			UNKNOWN_VERDICT,
			'The response carried no status this node recognises. Check that the base URL reaches TrustGuard’s /v1/evaluate rather than a proxy or a sign-in page.',
			cause,
		);
		this.name = 'TrustGuardUnknownVerdictError';
	}
}

// The five ways a parameter can arrive unusable, each with the message the user
// sees and what to do about it. Keyed by the union, so a reason cannot be added
// in payload.ts without deciding here what the user is told. Both messages name
// the parameter by its displayName, which is what n8n's UX guidelines ask for.
const INPUT_FAILURES: Record<InputReason, { message: string; description: string }> = {
	text_required: {
		message: TEXT_UNRESOLVED,
		description:
			'Set Text to an expression that resolves to a non-empty string. The usual cause is a path such as {{ $json.chatInput }} that this item does not carry. The node refuses to send an empty payload, because an empty payload scores allow and the real content would pass the gate unscanned.',
	},
	messages_json: {
		message: MESSAGES_UNUSABLE,
		description:
			'Messages holds text that is not JSON. n8n delivers this field as a string, so it must contain a JSON array such as [{"role":"user","content":"hi"}].',
	},
	messages_required: {
		message: MESSAGES_UNUSABLE,
		description:
			'Messages resolved to something that is not an array, or to an empty one. Give it at least one chat message.',
	},
	message_shape: {
		message: MESSAGES_UNUSABLE,
		description: 'One entry in Messages is not an object. Every entry needs a role and a content.',
	},
	role_missing: {
		message: MESSAGES_UNUSABLE,
		description:
			'One entry in Messages has no role. Every entry needs a non-empty role such as user, assistant or tool.',
	},
};

export class TrustGuardInputError extends TrustGuardError {
	readonly kind = 'input';

	readonly reason: InputReason;

	constructor(reason: InputReason) {
		const failure = INPUT_FAILURES[reason];
		super(failure.message, failure.description);
		this.name = 'TrustGuardInputError';
		this.reason = reason;
	}
}

// One sentence per check that can refuse a rewritten payload. The reason was
// already computed at every call site and then dropped on the floor - `reason`
// is not `description`, so NodeOperationError never picked it up and all
// twenty-one checks reached the user as the same five words.
//
// None of these is something the user can correct in the node: the service
// returned a payload that does not line up with what was sent, and the node
// refuses to forward it rather than guess. So each says what did not line up.
const TRANSFORM_REASONS: Record<TransformReason, string> = {
	missing_payload:
		'TrustGuard returned status transform with no transformed payload the node can apply, so the original was not forwarded.',
	message_count:
		'The rewritten payload holds a different number of messages than the node sent, so the node cannot line them up.',
	input_span:
		'TrustGuard returned a single input string for a multi-message payload, so the node cannot tell which message it redacts.',
	message_shape: 'One rewritten message is not an object, so the node cannot apply it.',
	role_missing: 'One rewritten message has no role, so the node cannot match it to the original.',
	role_mismatch:
		'A rewritten message changed the role of the message it replaces. The node rewrites content only, never roles.',
	content_type:
		'A rewritten message carries content that is neither a string nor an array of parts.',
	content_length:
		'A rewritten message has a different number of content parts than the message it replaces, so the node cannot line them up.',
	content_part_type: 'A rewritten content part is of a different kind than the part it replaces.',
	content_part_keys:
		'A rewritten content part carries keys beyond type and text, so the node cannot verify it is a plain text rewrite.',
	content_part_text: 'A rewritten content part carries no text string.',
	not_text_coverable:
		'TrustGuard returned one replacement string for content the node cannot treat as a single block of text.',
	tool_calls_missing:
		'The rewritten payload adds tool calls to a message that had none, or drops the array. The node rewrites arguments only, never the set of calls.',
	tool_call_count:
		'The rewritten payload holds a different number of tool calls than the message it replaces.',
	tool_call_shape: 'One rewritten tool call is not in a shape the node recognises.',
	tool_identity:
		'The original tool call carries no usable name and id, so nothing can be matched against it.',
	tool_name_mismatch:
		'A rewritten tool call changed the function name. The node rewrites arguments only, never identities.',
	tool_id_mismatch:
		'A rewritten tool call changed the call id. The node rewrites arguments only, never identities.',
	tool_args_json: 'A rewritten tool call carries arguments that are not valid JSON.',
	tool_args_type: 'A rewritten tool call carries arguments that are not a JSON object.',
	empty_transform:
		'A rewritten message changed neither content nor tool calls, so there is nothing to forward.',
};

export class TrustGuardTransformError extends TrustGuardError {
	readonly kind = 'transform';

	readonly reason: TransformReason;

	constructor(reason: TransformReason) {
		super(TRANSFORM_MISSING, TRANSFORM_REASONS[reason]);
		this.name = 'TrustGuardTransformError';
		this.reason = reason;
	}
}

// The split n8n's error-handling reference draws: NodeApiError for what the call
// to the service produced, NodeOperationError for what is wrong with the input
// or with what came back. A Record keyed by the union means a new kind does not
// compile until it has been put on one side or the other.
const NODE_ERROR_CLASS: Record<TrustGuardErrorKind, 'api' | 'operation'> = {
	unreachable: 'api',
	auth: 'api',
	entitlement: 'api',
	request: 'api',
	unknownVerdict: 'api',
	transform: 'operation',
	input: 'operation',
};

/**
 * The one place a failure becomes an error n8n understands. execute() calls it
 * with this.getNode(); everything upstream of it stays node-agnostic.
 */
export function toNodeError(
	node: INode,
	error: unknown,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	// n8n's own errors already name the right class and carry their own
	// description - a credential that cannot be decrypted, a parameter that
	// cannot be resolved. Rebuilding one of those as a NodeApiError blames the
	// service for something the workflow owner has to fix, so they pass through
	// and only gain the item index they were raised without. Re-wrapping would be
	// worse than pointless: both n8n constructors return their argument unchanged
	// when handed one of their own, so the itemIndex would be silently dropped.
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		if (error.context.itemIndex === undefined) {
			error.context.itemIndex = itemIndex;
		}
		return error;
	}

	if (error instanceof TrustGuardError) {
		// The error object goes in whole, not a rebuilt { message }: that is what
		// keeps the original as `cause` and lifts its description. Both
		// constructors take message and description straight off it, so the strings
		// the README documents do not move.
		if (NODE_ERROR_CLASS[error.kind] === 'operation') {
			return new NodeOperationError(node, error, { itemIndex });
		}
		// NodeApiError is typed for a response body rather than an Error, so the
		// cast is the same one n8n's own reference uses (`error as JsonObject`).
		// It reads message and description straight off the object, and keeps it
		// as the cause.
		return new NodeApiError(node, error as unknown as JsonObject, { itemIndex });
	}

	// Neither n8n's nor ours: a defect in this node or in something it called.
	// NodeOperationError is the class n8n's reference names for that, and the
	// original is kept as the cause rather than reduced to its message.
	return new NodeOperationError(node, error instanceof Error ? error : String(error), {
		itemIndex,
	});
}
