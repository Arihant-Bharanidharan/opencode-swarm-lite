# Security

## Responsible disclosure

If you discover a security issue in `opencode-swarm-lite`, please report it
responsibly. Do not open a public issue for vulnerabilities. Contact the project
maintainer through GitHub's private vulnerability reporting feature, or open a
private advisory.

## Provider API keys

- Users are responsible for their own provider API keys (NVIDIA NIM, OpenAI, Groq,
  Gemini, Mistral, etc.).
- Keys should remain local and environment-based. Never commit keys to this
  repository or to any log file.
- `.gitignore` excludes `.env*`, `*.log`, and `benchmark/logs/`; keep these
  exclusions in place.
- The runtime does not request, store, or transmit your keys beyond the configured
  provider endpoints.

## Provider limits

- Provider rate limits and quotas must be respected. The runtime includes a token
  bucket for dispatch rate limiting and a provider circuit breaker
  (closed / open / half_open).
- The runtime is **not** designed to bypass provider quotas or rate limits. Do not
  configure it to evade provider restrictions.

## Threat model

- Lane doctrine, relay protocol, and refine loop are prompt contracts. A weak or
  compromised model can ignore them; treat subagent output as untrusted until
  verified.
- The relay file is append-only markdown shared by concurrent lanes; on very fast
  parallel writers, last-append-wins is possible (same trust model as shared files
  generally).
- The role registry is agent-writable by design; a bad edit can degrade a custom
  role brief. Built-in briefs are only affected by an explicit `role:` block on
  their slug.

## Scope

This project is an orchestration runtime for OpenCode. It is not a sandbox, a
sandbox escape tool, or a credential manager. Security properties depend on the
underlying OpenCode installation and the provider endpoints you configure.
