import { describe, expect, it } from 'vitest';

import codex from '../nodes/TrustGuard/NeuralTrustTrustGuard.node.json';
import pkg from '../package.json';

import { NeuralTrustTrustGuard } from '../nodes/TrustGuard/NeuralTrustTrustGuard.node';

// The ten values n8n's codex reference documents. The editor matches these
// exactly and silently drops anything else, so an unsupported value costs the
// node its place in the panel without failing a build or a lint.
// https://docs.n8n.io/connect/create-nodes/build-your-node/reference/codex-files
const SUPPORTED_CATEGORIES = [
	'Analytics',
	'Communication',
	'Data & Storage',
	'Development',
	'Finance & Accounting',
	'Marketing & Content',
	'Miscellaneous',
	'Productivity',
	'Sales',
	'Utility',
];

describe('codex', () => {
	const description = new NeuralTrustTrustGuard().description;

	it('declares at least one category', () => {
		expect(codex.categories.length).toBeGreaterThan(0);
	});

	it('declares only categories n8n supports', () => {
		const unsupported = codex.categories.filter((c) => !SUPPORTED_CATEGORIES.includes(c));
		expect(unsupported).toEqual([]);
	});

	// 'AI' is a node-creator subcategory, not a category, and listing it under
	// categories is worse than inert: the node creator filters out every node
	// carrying it that does not also list 'Root Nodes' under subcategories.AI,
	// so the node stops showing up in panel search.
	it('does not list the AI subcategory as a category', () => {
		expect(codex.categories).not.toContain('AI');
	});

	it('points at this package and this node', () => {
		expect(codex.node).toBe(`${pkg.name}.${description.name}`);
	});
});
