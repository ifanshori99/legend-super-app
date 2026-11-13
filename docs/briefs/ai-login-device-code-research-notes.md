# Tanya AI device code: research checkpoint

Read-only investigation, 12 November 2026. No production B implementation or real OpenAI requests. Source Codex CLI locally reports `codex-cli 0.167.2`; source pinned to `rust-v0.167.2`. Founder Q26/Q88 and CTO safeguards in legend-z83k control implementation; older recommendation to block on commercial approval in the original research is superseded by that brief.

Original research is untracked in another checkout: `/Users/ifanshori99/Projects/legend super app/legend/docs/design/chatgpt-oauth-research.md`, section 3. Do not silently assume it exists in the branch.

## Device flow contract

Official Codex source: https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/login/src/device_code_auth.rs

- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann` (also https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/login/src/auth/manager.rs).
- Start: POST `https://auth.openai.com/api/accounts/deviceauth/usercode`, JSON `{client_id}`. Response has `device_auth_id`, `user_code` (alias `usercode`), `interval` encoded as a string. Parse and bound interval; never return device_auth_id to the browser.
- Owner verifies at fixed `https://auth.openai.com/codex/device`. Device flow expires after 15 minutes according to CLI, not a standard device_code token response with expires_in.
- Poll: POST `https://auth.openai.com/api/accounts/deviceauth/token`, JSON `{device_auth_id,user_code}`. HTTP 403 or 404 means pending. Success returns `{authorization_code,code_challenge,code_verifier}`.
- Exchange: POST `https://auth.openai.com/oauth/token`, FORM `{grant_type:"authorization_code",client_id,code,redirect_uri:"https://auth.openai.com/deviceauth/callback",code_verifier}`. Response source requires `{id_token,access_token,refresh_token}`; do not assume expires_in always exists. JWT exp can supply a refresh schedule, with safe bounds and untrusted-token handling.
- Token exchange source: https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/login/src/oauth/client.rs and https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/login/src/server.rs.

## Refresh and revoke

- Refresh POST same `/oauth/token` endpoint uses JSON in current CLI, `{grant_type:"refresh_token",client_id,refresh_token}` (optional CLI diagnostic `refresh_reason`). Source manager.rs `request_chatgpt_token_refresh`, client.rs comment explicitly distinguishes JSON refresh and form authorization grants.
- Refresh response fields id_token/access_token/refresh_token are optional in the source. Replace returned rotating credentials atomically; serialize refresh per connection to avoid reuse races. Never overwrite a concurrent revoke/new login. HTTP401, invalid_grant, refresh_token_expired/reused/invalidated are terminal; 429/network/5xx are transient. Do not log upstream body or raw exception message.
- Current CLI best-effort revokes refresh token via POST `https://auth.openai.com/oauth/revoke`, JSON `{token,token_type_hint:"refresh_token",client_id}`; delete local credentials even if upstream fails. Source: https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/login/src/auth/revoke.rs.
- Account ID metadata resides at JWT `https://api.openai.com/auth.chatgpt_account_id`; never treat decoding an unsigned JWT as independent proof of account identity. Source: https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/login/src/token_data.rs.

## Inference adapter

- Brief chooses fixed `POST https://chatgpt.com/backend-api/codex/responses`, Bearer access token, `ChatGPT-Account-ID` from bound token metadata; identify application honestly in originator. Hermes source: https://github.com/NousResearch/hermes-agent/blob/8e7908d9babe2ccc4dc4c0ae85477b5e81edbf78/agent/codex_headers.py.
- Responses payload: model, instructions/system converted as required, input messages/function_call/function_call_output, tools as `{type:"function",name,description,parameters,strict}`, `tool_choice:"auto"`, `parallel_tool_calls`, `reasoning:{effort}`, `store:false`, `stream:true`, `include:["reasoning.encrypted_content"]` when retaining opaque reasoning for tool replay. Do not forward foreign-provider opaque blocks.
- CLI request fields: https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/codex-api/src/common.rs (`ResponsesApiRequest`). Transport: https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/codex-api/src/endpoint/responses.rs.
- Parse bounded SSE across arbitrary chunks/CRLF. Accumulate `response.output_item.done`, including function_call, message output_text, and opaque reasoning; terminal `response.completed` carries usage `{input_tokens,output_tokens,output_tokens_details.reasoning_tokens}`. Reasoning tokens are included in output_tokens, do not add twice. Error/response.failed, malformed or truncated stream must fail; do not report success on delta or [DONE] alone. Source: https://github.com/openai/codex/blob/rust-v0.167.2/codex-rs/codex-api/src/sse/responses.rs.
- Fallback: use tenant custom provider on explicit auth failure/revocation, with its own normal A budget reservation. Ambiguous inference network failure can already have consumed plan usage; never silently claim it was free or retry without accounting policy. Re-check kill switch/connection state at each inference and after refresh; keep cache version sensitive to switch and connection revocation.

## Engineering decision: subscription accounting and output limits

Engineering decision agreed with parent on 13 November 2026, not a new founder business decision: distinguish subscription plan usage from incremental metered API spend. Codex CLI ResponsesApiRequest has no max_output_tokens field. Hermes generic adapter allows that field, but pinned transport specifically adds max_output_tokens only in the NON-Codex branch (`elif params.get("max_tokens") is not None`, lines 864–875): https://github.com/NousResearch/hermes-agent/blob/8e7908d9babe2ccc4dc4c0ae85477b5e81edbf78/agent/transports/codex.py.

These sources do not establish that Codex backend honors a hard output cap. Do not invent that guarantee or silently price subscription calls with A's metered API model table.

The selected integration contract is a server-owned `billingMode: "api_metered" | "chatgpt_plan"` on resolved providers. Plan calls record their actual token usage and request counts with an explicit plan billing mode, while incremental API-invoice cost is zero. This does not mean the owner's subscription is free, unlimited, or has a separate allowance: ChatGPT plan model eligibility and provider quotas remain authoritative and can reject a call. Do not estimate a monetary invoice from its model name or hide that distinction in reports.

All modes still pass initial and fresh per-call governance checks: default budget zero, disabled AI, exhausted configured budget, and daily quota block plan calls too. A custom-provider fallback must re-enter the metered gateway as a separate attempt with its own capability policy and atomic reservation, rather than hiding inside a plan adapter. Subscription token consumption on an ambiguous failure cannot be declared zero, and fallback is limited to explicit authentication failure/revocation rather than ambiguous inference failure. Local byte/time/tool-round bounds protect local resources; they do not guarantee an upstream output-token cap. Prove these semantics using fixtures, not real endpoints.

## Repository integration map

- Keep a separate `ai_chatgpt_connections` table so API-key config survives as fallback. Migration0418 only; RLS and registry references must agree.
- Seal access/refresh/pending device secret via `apps/api/src/lib/secrets.ts` AES-GCM, AAD binding tenant + connection + secret kind; preserve existing encryption key handling.
- Existing provider routes use auth, trusted origin, tenant context, backoffice surface and `requireTenantPermission("ai.governance.manage")`. Add owner template check via `getAccessSnapshot(req).allowsVia("owner","ai.governance.manage",{type:"tenant"})`; permission alone permits tenant_admin/custom roles. Pattern `apps/api/src/routes/pos-receipt-writeoff.routes.ts` ownerTemplateOnly.
- Tenant provider resolution in `services/ai-provider-config.service.ts`; gateway owns real calls and budget. Fallback must cover explicit failure from complete, not only initial resolution. All custom fallback must preserve A policies and bookkeeping.
- Logger currently redacts generic token fields but does not guarantee access_token/refresh_token at all depths. Avoid logging tokens or upstream bodies; tests must capture actual emitted logs with sentinel secrets.
- Shared contract should expose only status/consent actor+time/model/verification URL+user code (only start), never tokens/device_auth_id/PKCE/auth code. Poll by server-owned connection or attempt ID, owner tenant-bound; atomic DB poll claim and nextPollAt enforce concurrency rate limits.

Official documentation fetched: https://developers.openai.com/codex/auth redirects to https://learn.chatgpt.com/docs/auth. Current official SIWC app-server guidance instead uses approved OAuth access on public `/v1/responses`: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server. It does not establish the private Codex backend contract; use pinned implementation evidence above and keep this adapter isolated.

## Model capability bounds used for Codex aliases

On 13 November, Context7 and the fetched official model pages confirmed a 400,000 context window and 128,000 maximum output for [GPT-5-Codex](https://developers.openai.com/api/docs/models/gpt-5-codex), [GPT-5.1-Codex](https://developers.openai.com/api/docs/models/gpt-5.1-codex), and [GPT-5.3-Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex). GPT-5-Codex separately documents a 272,000 input maximum; GPT-5.3-Codex explicitly lists low/medium/high/xhigh reasoning. The isolated Codex Responses capability lookup uses a deliberately smaller operational window/output bound of 272,000/8,192 for these exact aliases, with low/medium/high efforts; they are not promoted in the generic Chat Completions table. These are conservative request preparation settings, not a claim that the private backend honors an output cap. The owner must submit an explicit model; no model is selected automatically, and availability remains provider-controlled. Older aliases may be deprecated or shut down, so this table is not an availability recommendation.

Unknown plan model names keep the small context/output fallback with tools and reasoning disabled. Protocol support alone is not proof that an arbitrary selected model supports those features. The custom provider path retains its separately detected/overridden capabilities and budget reservations.

The fetched official [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md) and [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md) pages, also checked with Context7, document 1,050,000 context, 922,000 maximum input and 128,000 output; both accept low/medium/high reasoning. Tool calling requires Responses. Exact aliases therefore receive conservative 272,000/8,192 operational limits only in the isolated Codex Responses capability lookup; the generic Chat Completions path is not promoted by this addition. Subscription eligibility is still checked by the upstream.

Race cleanup policy: stale/CAS-losing OAuth poll or refresh responses are discarded locally without an automatic upstream revoke. A refresh response can retain the same refresh token as the winning connection, so cleanup could otherwise revoke that winner; a read-then-revoke check also has a race. The explicit DELETE endpoint still clears local secrets first and best-effort revokes the captured current refresh token. Failure invalidation is fenced by the operation/cipher or the access token actually rejected, in addition to connection generation.
