# TrustGuard demo pack

Nine n8n workflows that exercise every operation, option and output, and the failure modes
of the `NeuralTrust TrustGuard` node.

These are not the same as [`../templates/`](../templates). Templates use HTTP
Request + Switch and need no community node. This pack uses the node itself.

## Setup

Import the JSON files under [`workflows/`](workflows) via **Workflows → ⋯ →
Import from File**, then create the credentials the pack refers to by name:

| Credential name | Type | Used by | Value |
| --- | --- | --- | --- |
| `NeuralTrust TrustGuard account` | TrustGuard API | 01–07, 09 | your `tgk_` key |
| `NeuralTrust TrustGuard (unreachable)` | TrustGuard API | 08 | any key, Base URL `http://127.0.0.1:9` |
| `NeuralTrust TrustGuard (TLS error)` | TrustGuard API | 08 | any key, Base URL of a host with an invalid certificate |
| `OpenAI account` | OpenAI | 09 | your own |

The workflows reference credentials by name, so n8n binds them automatically once
they exist. The two failure credentials let workflow 08 show that fail-open is
scoped to unreachability rather than to any error; their keys are never sent,
because the connection fails first.

## The workflows

| # | Workflow | Trigger | Shows |
| --- | --- | --- | --- |
| 01 | Input gate — the four verdicts | Chat | Allow / Report / Transform / Block routing from one node |
| 02 | Round trip — evaluate input and output | Chat | Both directions in one flow, and preserving the input verdict |
| 03 | Messages mode — multi-turn and tool calls | Manual | `payload.messages`, tool-call identity checks |
| 04 | Webhook API gate — 403 / 200 / 503 | Webhook | Verdicts mapped to HTTP status, plus the error output |
| 05 | Options matrix — every option, every protocol | Manual | All eight options; `protocol` validated against the payload |
| 06 | Transform deep dive | Chat | What a DLP rewrite changes on the item |
| 07 | Batch routing — 12 prompts | Manual | Per-item routing and a verdict histogram |
| 08 | Failure modes — fail closed vs fail open | Manual | The fail-open policy, including the TLS carve-out |
| 09 | Agent tool mode (`usableAsTool`) | Chat | Verdicts as a tool result, and why that is not enforcement |

Only 09 needs a model: 02 replaces the AI Agent with a Set node so
`direction=output` is testable without one. Each canvas carries sticky notes
explaining what it demonstrates.

Verdicts depend on the gates configured on your collector, so a branch with no
items means no probe produced that verdict — not a broken wire.

## Regenerating

The JSON is generated, so the node type and credential names live in one place.

```bash
python3 examples/generate.py
```

The committed files target the published node type
(`@neuraltrust/n8n-nodes-trustguard.neuralTrustTrustGuard`) and carry no workflow
IDs, so they import cleanly into any instance.

For a node linked by `n8n-node dev`, which registers under `CUSTOM.*`:

```bash
python3 examples/generate.py --dev
```

Credential names can be overridden with `--cred-name`, `--bad-cred-name`,
`--tls-cred-name` and `--openai-cred-name`.

## Importing from the command line

```bash
n8n import:workflow --separate --input=examples/workflows --projectId=<projectId>
```

Two things to know:

- `import:workflow` starts n8n's expression engine, which needs `isolated-vm`.
  On Node 25+ it fails with `IsolatePool failed to create any bridges`; use the
  Node version in `.nvmrc`.
- Repeated imports create duplicates, because the committed workflows have no
  ID. To update in place instead, keep a `{key: id}` map and pass
  `--ids <path>` when generating.
