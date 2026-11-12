# Tanya AI autodetect + device code — engineer execution brief

Source of requirements: coordinator user brief, cards legend-39d.8 then legend-z83k, founder Q88 and z83k CTO safeguards.
Branch: ws/ai-login-autodetect based on milestone/m1. A must be verified and committed before implementation of B. No UI, payments, loyalty, HRIS, merge, push or deployment.

A ownership: implement_provider owns capability detector, tenant provider config/service/table/shared provider contract and migration 0417. implement_orchestrator owns request policy, neutral completion types, OpenAI adapter, gateway/orchestrator and ai.ts reservation counter. test_writer owns new behavioral tests; test_runner alone runs heavy.

A sequence: test_writer creates red tests, test_runner runs them against baseline; implementers then code. Detect guarded GET models metadata fieldwise, then explicit known model table, then conservative defaults; validated tenant overrides persist separately and update cache version. Only detected reasoning permits reasoning_effort. Prompt budget includes system/tools/output and preserves tool pairs. Atomic worst-case budget reservation precedes every remote call/loop; reasoning output included in completion cap, default budget remains zero. Ambiguous network failure retains reservation.

B follows A commit: isolated ChatGPT Codex device/refresh/inference adapter, tenant owner-only opt-in with risk consent actor/time, encrypted tokens and pending device secret, no token/error-body logging, status/start/poll/revoke API with auth/origin/permission and polling rate limit. Fixed auth URLs/client ID from research; global validated env kill switch disables every OAuth operation and cached answers. Custom tenant provider remains fallback, never unrelated platform credentials. Migration 0418 only. No real OpenAI test calls; mock transport and responses.

Verification: failed-first targeted tests via heavy, related API tests, changed-file ESLint + Prettier, API/shared typecheck, migration registry/contract checks and generation drift check. Full pnpm check belongs to merge train per team policy. Build and auth e2e via heavy if required by active AGENTS. Fresh review A and architect-lens B before handoff, with release review architect xhigh + second opinion coordinated by CTO.

Context7 inspected 12 Nov 2026: OpenAI Model has id/object/created/owned_by (no advertised context); OpenRouter context_length + top_provider context_length/max_completion_tokens + supported_parameters; vLLM ModelCard max_model_len; Ollama compatible models lacks context, native show exposes model_info/capabilities (do not add native endpoint in this slice).
