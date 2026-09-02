# @neuraltrust/n8n-nodes-trustguard

n8n community node for [NeuralTrust TrustGuard](https://neuraltrust.ai). It calls `POST /v1/evaluate` and routes each item to **Allow**, **Report**, **Transform**, or **Block**.

This is a regular app node on the `main` path. It is not n8n Guardrails, not a LangChain sub-node, and not an Agent tool gate.

## Install

```bash
npm install @neuraltrust/n8n-nodes-trustguard
```

Or Settings → Community Nodes. In queue mode, install it on every worker.

## Credentials

Create **NeuralTrust TrustGuard API**:

| Field | Required | Notes |
| --- | --- | --- |
| API Key | yes | `tgk_…`. Stored as a password. Sent as `Authorization: Bearer`. |
| Base URL | no | Default `https://trustguard.neuraltrust.ai`. Override for a self-hosted TrustGuard. |
| Collector Key | no | `tgcol_…`. Routing identifier, not a secret. Omit when the API key is already bound to a collector. |

## Operations

- **Evaluate Input** — `direction: input`. Place before the AI Agent. Default text is `{{ $json.chatInput }}`.
- **Evaluate Output** — `direction: output`. Place after the AI Agent. Default text is `{{ $json.output }}`.

If the Text expression resolves to empty or undefined — for example the default `{{ $json.output }}` against a node that emits `text` instead — the node fails closed rather than evaluating an empty payload.

Input modes: **Text** (one chat message) or **Messages** (an OpenAI-style array, accepted either as a literal JSON array or as an expression).

As an AI Agent tool the four outputs do not exist; every verdict is returned to the agent on the single tool output. That makes the verdict visible, not enforced — a model can decline to call a tool. Use the main path for enforcement.

## Outputs

| TrustGuard `status` | Output |
| --- | --- |
| `allow` or `skip` | Allow |
| `report` | Report |
| `transform` | Transform — `guardrailsInput` becomes the rewritten text |
| `block` | Block — HTTP 200 from TrustGuard, not a node error |
| `ask` | Block — a node cannot prompt mid-execution, so the node applies the most restrictive verdict it can express. Matches the input phase only. `trustguard.status` stays `ask`, and nothing on the item is redacted, so an approval step branching off Block reads the original fields. |

Every item keeps incoming `chatInput` and `sessionId` so AI Agent `auto` prompt mode still works. The node also writes:

```json
{
  "guardrailsInput": "…",
  "trustguard": {
    "status": "allow",
    "trace_id": "…",
    "request_id": "…",
    "findings": [],
    "blockedMessage": "…",
    "workflowId": "…",
    "workflowName": "…",
    "executionId": "…"
  }
}
```

`blockedMessage` is set on the two verdicts that route to Block, `block` and `ask`, and carries the same
string as `guardrailsInput`. It reads `Blocked by NeuralTrust TrustGuard.` for both: in AI Agent tool mode
that string is what the model receives, and wording an `ask` as a pending confirmation would invite an agent
to treat a denial as something it can resolve.

`workflowId` / `executionId` are output metadata only. They are never sent in the evaluate body (unknown top-level keys return 400).

## Fail policy

Default is fail-closed. `block` and `ask` are branches, not errors.

Eligible for **Fail Open on Unreachable** only: timeout, connect error, HTTP 502, HTTP 504, HTTP 429 after retries.

Always fail closed: HTTP 401/403, 503, other 4xx/5xx, TLS errors, non-JSON 200, unknown `status`, unusable `transformed_payload`.

Transport failures are classified from the error `code` on the cause chain (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, …) as well as the message, because n8n rewrites those codes into prose before a node sees them. TLS and certificate failures are checked first and never count as unreachable — a possible MITM must not read as a transient blip.

Retries: `{429, 502, 504}`, 3 attempts. Backoff honors `Retry-After` (capped at 5s), else 0.25s then 0.5s. Default timeout 5s.

### On Error settings

`Fail Open on Unreachable` is scoped to transport failures. n8n's own **Settings → On Error** is not:

| On Error | Effect on a failed evaluation |
| --- | --- |
| **Stop Workflow** (default) | fails closed — the execution stops |
| **Continue (using error output)** | item goes to the node's 5th output, carrying `error` |
| **Continue** | item goes to the **Block** output with `trustguard.status: "error"`, `trustguard.evaluated: false` and `json.error` set |

No On Error setting can put an unevaluated item on the Allow output: failures are routed to Block, which n8n still relocates to the error output when that mode is selected.

`trustguard.evaluated === false` marks any item that reached a branch without being evaluated — set on both the fail-open Allow item and a Block-routed failure.

## Templates

Workflows built from HTTP Request + Switch, for instances where installing a community node is not an option:

- [`templates/chat-input-gate.json`](templates/chat-input-gate.json)
- [`templates/webhook-403.json`](templates/webhook-403.json)
- [`templates/output-scan.json`](templates/output-scan.json)

Import them in n8n, attach Header Auth (`Authorization: Bearer tgk_…`), and never paste keys into the JSON.
Their `Switch` is the enforcement point and its deny branch matches `block` and `ask`. Anything no rule matches
leaves on the Switch fallback output, so check where that wire goes before trusting a template.

## Develop

Node 20 to 24 (`nvm use` reads `.nvmrc`). Node 25+ cannot build n8n's `isolated-vm`.

```bash
npm install
npm test
npm run lint
npm run build
npm run dev
```

`npm run dev` starts n8n on `http://localhost:5678` with the node linked.

Live tests (optional, credentials stay out of git):

```bash
cp .env.example .env
# set TRUSTGUARD_API_KEY
npm run test:live
```

## License

[MIT](LICENSE)
