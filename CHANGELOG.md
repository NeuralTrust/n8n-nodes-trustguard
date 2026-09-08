# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-08

### Changed

- The error classes derive from n8n-workflow's `OperationalError` rather than
  from a bare `Error`, and the conversion to `NodeApiError` or
  `NodeOperationError` now lives in `errors.ts` beside them, keyed by an
  explicit table. What leaves the node is unchanged: every error still reaches
  n8n as one of those two classes, carrying the item index
- A parameter that does not resolve is no longer reported as a transform
  problem. `json.error` for an unresolved Text parameter changes from
  `TrustGuard transform missing payload` to `The Text parameter did not resolve
  to any text to evaluate`, and an unusable Messages parameter to `The Messages
  parameter did not resolve to a usable chat messages array`. A workflow
  branching on the old string needs updating
- Parameter and credential placeholders lead with `e.g.`, and the two operation
  actions drop their articles, per n8n's UX guidelines

### Added

- Every error carries a description. n8n shows it under the message and it names
  the parameter or the credential field to change. Until now every error this
  node raised carried none
- The twenty-one checks that can refuse a rewritten payload each say what did
  not line up, instead of all reading as the same five words

### Fixed

- A credential or parameter problem raised by n8n itself was re-presented as a
  TrustGuard service failure. It now passes through as the `NodeOperationError`
  n8n raised, with the item index stamped on it
- The item error no longer discards the failure it was built from. The
  classifying error is attached as its cause, where before the error was rebuilt
  from its message alone

## [0.2.1] - 2026-09-07

### Fixed

- The node codex declared the categories `AI` and `Security`. Neither is one of
  the ten categories n8n documents, so the editor dropped both. The codex now
  declares `Development` and `Utility`
- `AI` in `categories` was not merely ignored. n8n's node creator filters out
  every node carrying it that does not also list `Root Nodes` under an `AI`
  subcategory, so a panel search from a canvas holding no AI nodes, or from a
  node's plus endpoint, did not return TrustGuard
- `LICENSE` duplicated `FITNESS FOR` in the warranty clause. The file is now
  verbatim MIT

### Changed

- The node's Docs link and the credential's documentation link point at
  `docs.neuraltrust.ai/integrations/n8n` rather than the README

## [0.2.0] - 2026-09-02

### Fixed

- An `ask` verdict no longer fails the item with `TrustGuard returned an unknown
  verdict`. `ask` was missing from the known statuses, so a single Ask gate on
  the bound policy failed every evaluation on that collector

### Changed

- `ask` now routes to the **Block** output, matching TrustGuard's reduction
  order (`block > ask > transform > report > allow`). The item keeps
  `trustguard.status: "ask"`, so a workflow can branch on it. Items that
  previously reached the error output now reach Block, and a Block output left
  unwired drops them silently instead of failing the execution
- Only `allow` and `skip` route to Allow. Any other status routes to Block, so a
  verdict this version does not recognise fails closed rather than forwarding
- The three HTTP Request templates match `block` and `ask` on the Switch deny
  branch

## [0.1.0] - 2026-08-25

### Added

- `NeuralTrust TrustGuard` node with Evaluate Input and Evaluate Output operations
- Text and Messages input modes
- Named outputs: Allow, Report, Transform and Block, alongside n8n's error output
- TrustGuard API credential (`tgk_` key, optional collector key, base URL)
- Fail-closed transport, with opt-in fail-open limited to unreachable services
- Revalidation of server-supplied transforms before any rewritten text is forwarded
- HTTP Request templates for chat input, webhook 403 and output scan
- Demo workflow pack under `examples/`

[Unreleased]: https://github.com/NeuralTrust/n8n-nodes-trustguard/compare/0.3.0...HEAD
[0.3.0]: https://github.com/NeuralTrust/n8n-nodes-trustguard/releases/tag/0.3.0
[0.2.1]: https://github.com/NeuralTrust/n8n-nodes-trustguard/releases/tag/0.2.1
[0.2.0]: https://github.com/NeuralTrust/n8n-nodes-trustguard/releases/tag/0.2.0
[0.1.0]: https://github.com/NeuralTrust/n8n-nodes-trustguard/releases/tag/0.1.0
