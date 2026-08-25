import { TrustGuardTransformError } from './errors';
import type { ChatMessage, EvaluateBody, EvaluateDirection, JsonObject } from './types';

const TEXT_PART_KEYS = new Set(['type', 'text']);

function reject(reason: string): never {
	throw new TrustGuardTransformError(reason);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function textFromContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === 'string') {
					return part;
				}
				if (part && typeof part === 'object' && 'text' in part) {
					const text = (part as { text?: unknown }).text;
					return typeof text === 'string' ? text : '';
				}
				return '';
			})
			.join('');
	}
	return '';
}

export function lastMessageText(messages: ChatMessage[]): string {
	if (!messages.length) {
		return '';
	}
	return textFromContent(messages[messages.length - 1].content);
}

export function messagesFromText(text: string, direction: EvaluateDirection): ChatMessage[] {
	return [
		{
			role: direction === 'output' ? 'assistant' : 'user',
			content: text,
		},
	];
}

export function requireText(value: unknown): string {
	// Fail closed. n8n resolves a whole-string expression whose path is missing to
	// `undefined`, and getNodeParameter's fallback only fires when the parameter
	// itself is absent - which it never is, because the Workflow constructor fills
	// property defaults in. Without this guard an unresolved Text expression would
	// be sent as an empty payload, scored `allow`, and routed to the Allow output
	// while the real content sat unscanned on the item.
	if (typeof value !== 'string' || !value.trim()) {
		throw new TrustGuardTransformError('text_required');
	}
	return value;
}

export function normalizeMessages(value: unknown): ChatMessage[] {
	let parsed = value;
	// n8n does not JSON-parse a `type: 'json'` parameter - its own nodes call
	// jsonParse themselves. A literal array typed into the field, or any
	// expression that resolves to a string, arrives here as text.
	if (typeof parsed === 'string') {
		parsed = parseJson(parsed);
		if (parsed === undefined) {
			reject('messages_json');
		}
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new TrustGuardTransformError('messages_required');
	}
	return parsed.map((item) => {
		if (!item || typeof item !== 'object') {
			throw new TrustGuardTransformError('message_shape');
		}
		const role = (item as ChatMessage).role;
		if (typeof role !== 'string' || !role) {
			throw new TrustGuardTransformError('role_missing');
		}
		return { ...(item as ChatMessage) };
	});
}

export function buildEvaluateBody(options: {
	messages: ChatMessage[];
	direction: EvaluateDirection;
	protocol?: string;
	modelName?: string;
	modelProvider?: string;
	collectorKey?: string;
	sessionId?: string;
	consumerId?: string;
}): EvaluateBody {
	const attributes: JsonObject = {
		content_type: 'application/json',
		model: {
			name: options.modelName ?? '',
			...(options.modelProvider ? { provider: options.modelProvider } : {}),
		},
	};

	const body: EvaluateBody = {
		payload: { messages: options.messages },
		direction: options.direction,
		protocol: options.protocol || 'llm',
		attributes,
	};

	if (options.collectorKey) {
		body.collector_key = options.collectorKey;
	}
	if (options.sessionId) {
		body.session_id = options.sessionId;
	}
	if (options.consumerId) {
		body.consumer_id = options.consumerId;
	}

	return body;
}

function isTextPart(part: unknown): part is Record<string, unknown> {
	if (typeof part === 'string') {
		return true;
	}
	if (!part || typeof part !== 'object') {
		return false;
	}
	const record = part as Record<string, unknown>;
	if (record.type !== undefined && record.type !== 'text') {
		return false;
	}
	return Object.keys(record).every((key) => TEXT_PART_KEYS.has(key));
}

function redactedContent(content: unknown, redacted: string): unknown {
	if (typeof content === 'string') {
		return redacted;
	}
	if (Array.isArray(content) && content.length === 1) {
		const part = content[0];
		if (typeof part === 'string') {
			return [redacted];
		}
		if (isTextPart(part) && part && typeof part === 'object') {
			return [{ ...part, text: redacted }];
		}
	}
	reject('not_text_coverable');
}

function applyContentPart(original: unknown, incoming: unknown): unknown {
	if (typeof original === 'string') {
		if (typeof incoming !== 'string') {
			reject('content_part_type');
		}
		return incoming;
	}
	if (original && typeof original === 'object' && incoming && typeof incoming === 'object') {
		if (!isTextPart(original) || !isTextPart(incoming)) {
			reject('content_part_keys');
		}
		const text = (incoming as { text?: unknown }).text;
		if (typeof text !== 'string') {
			reject('content_part_text');
		}
		return { ...(original as object), text };
	}
	reject('content_part_type');
}

function applyContentList(originalContent: unknown, incoming: unknown[]): unknown[] {
	if (!Array.isArray(originalContent) || originalContent.length !== incoming.length) {
		reject('content_length');
	}
	return originalContent.map((original, index) => applyContentPart(original, incoming[index]));
}

function parseToolArgs(raw: unknown): JsonObject {
	let value = raw;
	if (typeof value === 'string') {
		try {
			value = value ? JSON.parse(value) : {};
		} catch {
			reject('tool_args_json');
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		reject('tool_args_type');
	}
	return value as JsonObject;
}

function incomingToolCall(item: unknown): { name: string; args: JsonObject; id?: string } {
	if (!item || typeof item !== 'object') {
		reject('tool_call_shape');
	}
	const record = item as Record<string, unknown>;
	if ('name' in record && 'args' in record) {
		const callId = record.id;
		return {
			name: String(record.name ?? ''),
			args: parseToolArgs(record.args),
			id: typeof callId === 'string' && callId ? callId : undefined,
		};
	}
	const fn = record.function;
	if (!fn || typeof fn !== 'object') {
		reject('tool_call_shape');
	}
	const functionRecord = fn as Record<string, unknown>;
	const callId = record.id;
	return {
		name: String(functionRecord.name ?? ''),
		args: parseToolArgs(functionRecord.arguments ?? '{}'),
		id: typeof callId === 'string' && callId ? callId : undefined,
	};
}

function originalToolIdentity(original: unknown): { name: string; id: string } {
	if (!original || typeof original !== 'object') {
		reject('tool_identity');
	}
	const record = original as Record<string, unknown>;
	let name = String(record.name ?? '');
	const callId = String(record.id ?? '');
	const fn = record.function;
	if (fn && typeof fn === 'object') {
		name = name || String((fn as { name?: unknown }).name ?? '');
	}
	if (!name || !callId) {
		reject('tool_identity');
	}
	return { name, id: callId };
}

function applyToolCalls(originalCalls: unknown[], incomingCalls: unknown[]): JsonObject[] {
	if (incomingCalls.length !== originalCalls.length) {
		reject('tool_call_count');
	}
	return originalCalls.map((original, index) => {
		const incoming = incomingToolCall(incomingCalls[index]);
		const identity = originalToolIdentity(original);
		if (incoming.name && incoming.name !== identity.name) {
			reject('tool_name_mismatch');
		}
		if (incoming.id && incoming.id !== identity.id) {
			reject('tool_id_mismatch');
		}
		return {
			id: identity.id,
			type: 'function',
			function: {
				name: identity.name,
				arguments: JSON.stringify(incoming.args),
			},
		};
	});
}

function originalToolCalls(message: ChatMessage): unknown[] | undefined {
	if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
		return message.tool_calls;
	}
	return undefined;
}

function applyOne(original: ChatMessage, incoming: unknown): ChatMessage {
	if (!incoming || typeof incoming !== 'object') {
		reject('message_shape');
	}
	const record = incoming as Record<string, unknown>;
	const incomingRole = record.role;
	if (typeof incomingRole !== 'string' || !incomingRole) {
		reject('role_missing');
	}
	if (incomingRole !== original.role) {
		reject('role_mismatch');
	}

	const next: ChatMessage = { ...original };
	let updated = false;

	if ('content' in record) {
		const content = record.content;
		if (typeof content === 'string') {
			next.content = redactedContent(original.content, content);
		} else if (Array.isArray(content)) {
			next.content = applyContentList(original.content, content);
		} else {
			reject('content_type');
		}
		updated = true;
	}

	if ('tool_calls' in record) {
		const incomingCalls = record.tool_calls;
		const originalCalls = originalToolCalls(original);
		if (!Array.isArray(incomingCalls) || originalCalls === undefined) {
			reject('tool_calls_missing');
		}
		next.tool_calls = applyToolCalls(originalCalls, incomingCalls);
		updated = true;
	}

	if (!updated) {
		reject('empty_transform');
	}
	return next;
}

export function applyTransform(messages: ChatMessage[], transformed: unknown): ChatMessage[] {
	if (!transformed || typeof transformed !== 'object') {
		reject('missing_payload');
	}
	const payload = transformed as Record<string, unknown>;
	const rawMessages = payload.messages;

	if (Array.isArray(rawMessages) && rawMessages.length) {
		if (rawMessages.length !== messages.length) {
			reject('message_count');
		}
		return messages.map((message, index) => applyOne(message, rawMessages[index]));
	}

	const rawInput = payload.input;
	if (typeof rawInput !== 'string' || !rawInput) {
		reject('missing_payload');
	}
	if (messages.length !== 1) {
		reject('input_span');
	}
	const [original] = messages;
	return [
		{
			...original,
			content: redactedContent(original.content, rawInput),
		},
	];
}
