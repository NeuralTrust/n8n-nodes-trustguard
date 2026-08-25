# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `NeuralTrust TrustGuard` node with Evaluate Input and Evaluate Output operations
- Text and Messages input modes
- Named outputs: Allow, Report, Transform and Block, alongside n8n's error output
- TrustGuard API credential (`tgk_` key, optional collector key, base URL)
- Fail-closed transport, with opt-in fail-open limited to unreachable services
- Revalidation of server-supplied transforms before any rewritten text is forwarded
- HTTP Request templates for chat input, webhook 403 and output scan
- Demo workflow pack under `examples/`

[Unreleased]: https://github.com/NeuralTrust/n8n-nodes-trustguard/commits/main
