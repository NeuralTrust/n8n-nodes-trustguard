import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
	Icon,
} from 'n8n-workflow';

export class TrustGuardApi implements ICredentialType {
	name = 'trustGuardApi';

	displayName = 'NeuralTrust TrustGuard API';

	documentationUrl = 'https://docs.neuraltrust.ai';

	icon: Icon = {
		light: 'file:../nodes/TrustGuard/trustguard.svg',
		dark: 'file:../nodes/TrustGuard/trustguard.dark.svg',
	};

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'tgk_…',
			description: 'TrustGuard collector API key. Starts with tgk_.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://trustguard.neuraltrust.ai',
			placeholder: 'https://trustguard.neuraltrust.ai',
			description: 'TrustGuard evaluate base URL. Override for a self-hosted TrustGuard.',
		},
		{
			displayName: 'Collector Key',
			name: 'collectorKey',
			type: 'string',
			default: '',
			placeholder: 'tgcol_…',
			description:
				'Optional routing identifier. Not a secret. Omit when the API key is already bound to a collector.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			// Mirror the node's DEFAULT_API_BASE fallback: clearing the optional Base
			// URL must not break the credential test when execution still works.
			baseURL: '={{$credentials.baseUrl || "https://trustguard.neuraltrust.ai"}}',
			url: '/v1/evaluate',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: {
				payload: { input: 'ping' },
				protocol: 'all',
				direction: 'input',
				// Not `|| undefined`: an unresolved expression serializes as the string
				// "undefined", which the API rejects with 403. Empty is accepted.
				collector_key: '={{$credentials.collectorKey}}',
			},
		},
	};
}
