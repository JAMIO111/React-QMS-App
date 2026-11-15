# Agent ↔ Fortress contract

Fixtures both sides test against (docs/connector-agent-plan.md §10 "Contract"):

- `signature-vector.json` — one signed request: the canonical string both sides must build and a signature both must accept.
  Checked by `api/src/integrations/agents/agent-signature.spec.ts` and `connector-agent/tests/Fortress.Agent.Tests/ContractTests.cs`.
- `sealed-credential.json` — a database password sealed with WebCrypto as the browser seals it; the agent tests open it, and the browser code in `src/lib/sealCredential.js` is tested to produce the same shape.
- `messages/*.json` — the bodies the agent sends. The API test parses each with the route's own schema; the agent test checks that
  what it serialises has exactly the same fields.

Change a message here first, then make both tests pass.
