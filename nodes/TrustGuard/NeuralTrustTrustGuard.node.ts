import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { TrustGuardTransformError, TrustGuardUnreachableError } from './errors';
import {
	applyTransform,
	buildEvaluateBody,
	lastMessageText,
	messagesFromText,
	normalizeMessages,
	requireText,
} from './payload';
import { blockText, createN8nSender, evaluateWithSender } from './transport';
import type { ChatMessage, EvaluateDirection, TrustGuardVerdict } from './types';
import { DEFAULT_API_BASE, DEFAULT_TIMEOUT_SECONDS } from './types';

const OUTPUT_ALLOW = 0;
const OUTPUT_REPORT = 1;
const OUTPUT_TRANSFORM = 2;
const OUTPUT_BLOCK = 3;

type NodeOptions = {
	sessionId?: string;
	consumerId?: string;
	modelName?: string;
	modelProvider?: string;
	collectorKey?: string;
	protocol?: string;
	timeout?: number;
	failOpenOnUnreachable?: boolean;
};

// Only the statuses that are known to be safe to forward reach Allow;
// everything else lands on Block. `ask` asks for human confirmation and a node
// has no confirmation surface mid-execution, so Block is the most restrictive
// output the node can express - which is also where TrustGuard's own reduction
// order puts it (block > ask > transform > report > allow). Listing the passing
// statuses rather than the denying ones matters: a status added to
// KNOWN_STATUSES without a branch here fails closed instead of silently
// forwarding.
function outputIndex(status: TrustGuardVerdict['status']): number {
	if (status === 'allow' || status === 'skip') {
		return OUTPUT_ALLOW;
	}
	if (status === 'report') {
		return OUTPUT_REPORT;
	}
	if (status === 'transform') {
		return OUTPUT_TRANSFORM;
	}
	return OUTPUT_BLOCK;
}

// Derived from the routing above so the gate message and the branch can never
// disagree.
function routesToBlock(status: TrustGuardVerdict['status']): boolean {
	return outputIndex(status) === OUTPUT_BLOCK;
}

function attachMetadata(
	ctx: IExecuteFunctions,
	incoming: IDataObject,
	trustguard: IDataObject,
): IDataObject {
	const workflow = ctx.getWorkflow();
	return {
		...incoming,
		trustguard: {
			...trustguard,
			workflowId: workflow.id,
			workflowName: workflow.name,
			executionId: ctx.getExecutionId(),
		},
	};
}

function toNodeError(
	ctx: IExecuteFunctions,
	error: unknown,
	itemIndex: number,
): NodeApiError | NodeOperationError {
	if (error instanceof TrustGuardTransformError) {
		return new NodeOperationError(ctx.getNode(), error, { itemIndex });
	}
	const message = error instanceof Error ? error.message : String(error);
	return new NodeApiError(ctx.getNode(), { message }, { itemIndex });
}

async function evaluateItem(
	ctx: IExecuteFunctions,
	item: INodeExecutionData,
	itemIndex: number,
	options: NodeOptions,
): Promise<{ index: number; data: INodeExecutionData }> {
	const operation = ctx.getNodeParameter('operation', itemIndex) as string;
	const inputMode = ctx.getNodeParameter('inputMode', itemIndex) as string;
	const direction: EvaluateDirection = operation === 'evaluateOutput' ? 'output' : 'input';

	const credentials = await ctx.getCredentials('trustGuardApi');
	const baseUrl =
		typeof credentials.baseUrl === 'string' && credentials.baseUrl
			? credentials.baseUrl
			: DEFAULT_API_BASE;
	const credentialCollector =
		typeof credentials.collectorKey === 'string' ? credentials.collectorKey : '';
	const collectorKey = options.collectorKey || credentialCollector;

	let messages: ChatMessage[];
	if (inputMode === 'messages') {
		messages = normalizeMessages(ctx.getNodeParameter('messages', itemIndex));
	} else {
		const text = requireText(ctx.getNodeParameter('text', itemIndex, ''));
		messages = messagesFromText(text, direction);
	}

	const body = buildEvaluateBody({
		messages,
		direction,
		protocol: options.protocol,
		modelName: options.modelName,
		modelProvider: options.modelProvider,
		collectorKey,
		sessionId: options.sessionId,
		consumerId: options.consumerId,
	});

	let verdict: TrustGuardVerdict | undefined;
	let failure: unknown;
	try {
		verdict = await evaluateWithSender(
			createN8nSender(ctx, {
				baseUrl,
				body,
				timeoutSeconds: options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
			}),
		);
	} catch (error) {
		failure = error;
	}

	if (!verdict) {
		if (failure instanceof TrustGuardUnreachableError && options.failOpenOnUnreachable) {
			// Handled here rather than in execute() so the item keeps the output
			// contract every Allow item is expected to satisfy.
			const json = attachMetadata(ctx, item.json, {
				status: 'allow',
				error: failure.message,
				unreachable: true,
				evaluated: false,
			});
			json.guardrailsInput = lastMessageText(messages);
			if (inputMode === 'messages') {
				json.messages = messages as unknown as IDataObject[];
			}
			return { index: OUTPUT_ALLOW, data: { json, pairedItem: { item: itemIndex } } };
		}
		// execute() maps the typed TrustGuard errors to NodeApiError /
		// NodeOperationError in one place.
		throw failure;
	}

	let outgoingMessages = messages;
	let guardrailsInput = lastMessageText(messages);

	if (verdict.status === 'transform') {
		outgoingMessages = applyTransform(messages, verdict.transformedPayload);
		guardrailsInput = lastMessageText(outgoingMessages);
	} else if (routesToBlock(verdict.status)) {
		guardrailsInput = blockText(verdict);
	}

	const json = attachMetadata(ctx, item.json, {
		status: verdict.status,
		trace_id: verdict.traceId,
		request_id: verdict.requestId,
		findings: verdict.findings as IDataObject | IDataObject[] | undefined,
		blockedMessage: routesToBlock(verdict.status) ? blockText(verdict) : undefined,
	});

	json.guardrailsInput = guardrailsInput;
	if (inputMode === 'messages') {
		json.messages = outgoingMessages as unknown as IDataObject[];
	} else if (verdict.status === 'transform') {
		if (direction === 'input' && 'chatInput' in json) {
			json.chatInput = guardrailsInput;
		}
		if (direction === 'output' && 'output' in json) {
			json.output = guardrailsInput;
		}
	}

	return {
		index: outputIndex(verdict.status),
		data: {
			json,
			pairedItem: { item: itemIndex },
		},
	};
}

export class NeuralTrustTrustGuard implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'NeuralTrust TrustGuard',
		name: 'neuralTrustTrustGuard',
		icon: { light: 'file:trustguard.svg', dark: 'file:trustguard.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"]}}',
		description: 'Evaluate LLM input or output with NeuralTrust TrustGuard (POST /v1/evaluate)',
		defaults: {
			name: 'TrustGuard',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [
			NodeConnectionTypes.Main,
			NodeConnectionTypes.Main,
			NodeConnectionTypes.Main,
			NodeConnectionTypes.Main,
		],
		outputNames: ['Allow', 'Report', 'Transform', 'Block'],
		credentials: [
			{
				name: 'trustGuardApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Evaluate Input',
						value: 'evaluateInput',
						action: 'Evaluate input before the model',
						description: 'Send direction=input. Place this node before the AI Agent.',
					},
					{
						name: 'Evaluate Output',
						value: 'evaluateOutput',
						action: 'Evaluate output after the model',
						description: 'Send direction=output. Place this node after the AI Agent.',
					},
				],
				default: 'evaluateInput',
			},
			{
				displayName: 'Input Mode',
				name: 'inputMode',
				type: 'options',
				options: [
					{
						name: 'Text',
						value: 'text',
						description: 'Evaluate a single string as one chat message',
					},
					{
						name: 'Messages',
						value: 'messages',
						description: 'Evaluate an OpenAI-style chat messages array',
					},
				],
				default: 'text',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				default: '={{ $json.chatInput }}',
				required: true,
				displayOptions: {
					show: {
						operation: ['evaluateInput'],
						inputMode: ['text'],
					},
				},
				description: 'Text to evaluate. Defaults to the Chat Trigger chatInput field.',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				default: '={{ $json.output }}',
				required: true,
				displayOptions: {
					show: {
						operation: ['evaluateOutput'],
						inputMode: ['text'],
					},
				},
				description: 'Text to evaluate. Defaults to the AI Agent output field.',
			},
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'json',
				default: '={{ $json.messages }}',
				required: true,
				displayOptions: {
					show: {
						inputMode: ['messages'],
					},
				},
				description: 'OpenAI chat messages array to send as payload.messages',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Collector Key',
						name: 'collectorKey',
						type: 'string',
						default: '',
						placeholder: 'tgcol_…',
						description: 'Override the collector key from credentials. Routing identifier, not a secret.',
					},
					{
						displayName: 'Consumer ID',
						name: 'consumerId',
						type: 'string',
						default: '',
						description: 'Optional TrustGuard consumer_id',
					},
					{
						displayName: 'Fail Open on Unreachable',
						name: 'failOpenOnUnreachable',
						type: 'boolean',
						default: false,
						description: 'Whether to continue on the Allow output when TrustGuard is unreachable (timeout, connect, 429/502/504 after retries). Auth, 503, unknown verdicts, and bad transforms still fail closed.',
					},
					{
						displayName: 'Model Name',
						name: 'modelName',
						type: 'string',
						default: '',
						placeholder: 'gpt-4o-mini',
						description: 'Optional attributes.model.name used for gate matching',
					},
					{
						displayName: 'Model Provider',
						name: 'modelProvider',
						type: 'string',
						default: '',
						placeholder: 'openai',
						description: 'Optional attributes.model.provider',
					},
					{
						displayName: 'Protocol',
						name: 'protocol',
						type: 'options',
						options: [
							{ name: 'A2A', value: 'a2a' },
							{ name: 'All', value: 'all' },
							{ name: 'LLM', value: 'llm' },
							{ name: 'MCP', value: 'mcp' },
						],
						default: 'llm',
						description: 'TrustGuard protocol. LLM is the correct value for chat workflows.',
					},
					{
						displayName: 'Session ID',
						name: 'sessionId',
						type: 'string',
						default: '={{ $json.sessionId }}',
						description: 'Optional TrustGuard session_id for multiturn correlation',
					},
					{
						displayName: 'Timeout (Seconds)',
						name: 'timeout',
						type: 'number',
						typeOptions: {
							minValue: 1,
							maxValue: 60,
						},
						default: DEFAULT_TIMEOUT_SECONDS,
						description: 'HTTP timeout for POST /v1/evaluate',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const outputs: INodeExecutionData[][] = [[], [], [], []];

		// The synthetic tool variant n8n mints for `usableAsTool` declares a single
		// ai_tool output, and its wrapper reads ONLY output index 0
		// (mapResult in n8n-core get-input-connection-data.js). Routing a block to
		// index 3 there would hand the agent an empty array, which reads as "nothing
		// wrong" - the worst possible direction for a guardrail to fail. As a tool,
		// every verdict goes to index 0 so the agent always sees the real verdict.
		const asTool = this.getNode().type.endsWith('Tool');

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const item = items[itemIndex];
			const options = this.getNodeParameter('options', itemIndex, {}) as NodeOptions;

			try {
				const routed = await evaluateItem(this, item, itemIndex, options);
				outputs[asTool ? OUTPUT_ALLOW : routed.index].push(routed.data);
			} catch (error) {
				const nodeError = toNodeError(this, error, itemIndex);

				if (this.continueOnFail()) {
					// continueOnFail() is true for BOTH continueRegularOutput and
					// continueErrorOutput, but n8n only relocates an item to the error
					// output in the latter. So this lands on Block, not Allow: under
					// continueErrorOutput n8n still moves it to the error output (it
					// scans main outputs 0..3 for item.error), and under
					// continueRegularOutput it fails CLOSED instead of letting an
					// unevaluated item through the gate.
					const json = attachMetadata(this, item.json, {
						status: 'error',
						evaluated: false,
						error: nodeError.message,
					});
					json.guardrailsInput = blockText({ status: 'block', raw: {} });
					// Also at top level: n8n's error-output relocation and the
					// documented item contract both read `json.error`.
					json.error = nodeError.message;
					outputs[asTool ? OUTPUT_ALLOW : OUTPUT_BLOCK].push({
						json,
						error: nodeError,
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				throw nodeError;
			}
		}

		return outputs;
	}
}
