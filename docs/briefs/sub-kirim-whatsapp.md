# Brief bersama: adapter Kirimdev outbound (legend-w8dfz) + verifikasi webhook (legend-6qyk)

Penyedia: Kirimdev, https://docs.kirimdev.com/ (BUKAN kirim.dev). Tidak ada token nyata dan tidak ada sandbox: test memakai mock `fetch`. Jangan log nomor telepon penuh, token, atau isi pesan. Migrasi: tidak diperlukan (rentang 0450-0452 cadangan). Jangan sentuh uang/QRIS/AI/edge/notification worker.

## Fakta API (dibaca dari docs resmi 13 Nov 2026)

- Base `https://api.kirimdev.com`. Auth `Authorization: Bearer kdv_live_<24 base64url>` (33 karakter). Tidak ada key sandbox.
- Kirim teks: `POST /v1/{phone_number_id}/messages`, body
  `{"messaging_product":"whatsapp","to":"+628...","type":"text","text":{"body":"..."}}` (maks 4096). Sukses 202 (docs prosa) atau 200 (OpenAPI): terima keduanya. Respons `{"data":{"id":"msg_...","status":"queued",...},"request_id":"req_..."}`.
- `Idempotency-Key` header (string bebas; per organisasi; TTL 24 jam; hash method+path+body; sama+body beda = 422 `idempotency_key_reuse`; sedang diproses = 409 `idempotency_in_progress` -> retry kunci sama; 5xx tidak di-cache).
- Error: `{"error":{"type","code","message","param","request_id"}}`. Retry: 429 (hormati `Retry-After` detik, jitter 0.75-1.25, batasi maks 8 detik), 502 `whatsapp_upstream_error`, 503 (`Retry-After` bila ada), 409 `idempotency_in_progress`, galat jaringan. Tidak retry: 400, 401, 402, 403, 404, 422 (termasuk `outside_24h_window` Meta 131047, `marketing_opted_out`, `contact_blocked`).
- Teks bebas hanya di dalam jendela 24 jam sejak pesan masuk pelanggan; di luar itu `outside_24h_window`. Template (`type:"template"`) tidak punya batas itu tetapi di luar scope kartu ini.
- Rate limit write: Starter 60/menit per organisasi.
- Webhook: `X-Kirim-Signature: t=<unix>,v1=<hex>[,v1=...]`, HMAC-SHA256 `"<t>.<raw body>"`, toleransi 300 detik, dedupe `X-Kirim-Event-Id` (wamid). Retry webhook Kirimdev: 8 percobaan sampai 24 jam, timeout 10 detik per percobaan, 408/429/5xx diretry, 4xx lain mati, auto-disable langganan setelah 20 kegagalan beruntun (tanpa email/alert). Jadi 503 saat secret kosong akan mematikan langganan: catat di runbook.
- Payload inbound: `entry[0].changes[0].value.metadata.phone_number_id`, `messages[0].from|id|text.body|type`.

## Kontrak modul baru (potongan A)

File: `apps/api/src/services/messaging-kirimdev.ts`, export:

```ts
export type KirimdevMessagingOptions = {
  apiKey: string; // wajib cocok /^kdv_live_[A-Za-z0-9_-]{24}$/, selain itu throw TypeError (tanpa mencetak nilainya)
  baseUrl?: string; // default https://api.kirimdev.com, hanya https
  fetch?: typeof fetch; // seam test
  resolveSender: (context: ScopedTenantContext) => Promise<string | null>; // phone_number_id nomor tenant; null = fail tertutup
  webhookSecrets: readonly string[];
  timeoutMs?: number; // default 10000
  maxAttempts?: number; // default 3
  sleep?: (ms: number) => Promise<void>; // seam test
  now?: () => number; // detik Unix, seam test verifyWebhook
};
export function createKirimdevMessagingProvider(
  options: KirimdevMessagingOptions,
): Pick<MessagingProvider, "verifyWebhook" | "send">;
export class KirimdevSendError extends Error { // tanpa nomor/teks/token di message
  readonly code: string; // kode Kirimdev atau "network" | "timeout" | "no_sender" | "invalid_response"
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
}
/** Dari env: null bila KIRIM_API_KEY kosong (outbound mati). */
export function getKirimdevMessaging(deps: { resolveSender; env?: Env }): ... | null;
```

Perilaku `send(context, input)`:

1. `accept`-pola dari `packages/shared/src/adapters/safety.ts` (validasi `messageRequestSchema`, scope tenant/outlet context vs input; salah scope throw seperti FakeMessagingProvider).
2. `resolveSender` null -> `KirimdevSendError("no_sender")`, tanpa panggilan HTTP.
3. `to = "+" + recipient` (digit). Idempotency-Key = sha256 hex dari `"<tenantId>:<outletId>:<reference>"` (referensi sama = pesan sama; stabil antar retry dan crash).
4. Retry sesuai fakta di atas, maks `maxAttempts`, kunci Idempotency sama tiap percobaan. Timeout via AbortController.
5. Sukses: `{reference, accepted:true}` (`operationResultSchema`). Respons 2xx tanpa `data.id` string: `invalid_response`.
6. Pesan error dan log hanya: status, code, request_id. Jangan menyertakan body respons, nomor, teks, header Authorization.
7. `verifyWebhook` = `verifyKirimWebhook` dengan `webhookSecrets` (tolak daftar kosong).

Resolver DB (potongan A, fungsi kedua): `kirimdevSenderFromIntegrations(database)` membaca `tenant_integrations` provider `whatsapp`, status `active`, `config.phoneNumberId` milik `context.tenantId` (RLS/filter tenant). Cek pola di `services/platform-integration.service.ts` dan `services/identity-wa-inbound.service.ts` (`routingNumber`).

## Potongan B (env + docs)

- `apps/api/src/config/env.ts`: `KIRIM_API_KEY` (opsional, format kdv_live_, jangan echo nilai di pesan galat), `KIRIM_API_BASE_URL` (opsional, https). `.env.example`: komentar + nama key kosong. `docs/deployment.md` bagian "Kirimdev inbound WhatsApp": ganti kalimat "application never holds it / outbound off" menjadi: key hanya dibutuhkan bila outbound dinyalakan, `ghostex secret request`, outbound tidak dipanggil siapa pun sampai fitur memakainya, batasan 24 jam, biaya. `docs/runbooks/kirimdev-webhook.md`: tambah bagian "Retry Kirimdev dan auto-disable" (20 kegagalan beruntun mematikan langganan; 503 secret kosong memicu itu; cek `GET /v1/webhook_subscriptions` status; aktifkan lagi lewat PATCH status active dan replay `POST /v1/webhook_deliveries/{id}/replay`). `docs/plan/providers.md`: satu paragraf adapter produksi.

## Test (potongan C, test-writer)

1. `apps/api/src/test/messaging-kirimdev.test.ts`: mock `fetch`. Kasus: sukses 202 dan 200; URL/headers/body tepat (Bearer, Idempotency-Key stabil, to "+" digit); retry 429 dengan Retry-After lalu sukses (kunci sama); 503 lalu sukses; 502; jaringan lalu sukses; habis percobaan -> error retryable; 400/401/422 `outside_24h_window` tidak retry; tanpa sender -> no_sender tanpa fetch; scope tenant salah ditolak; respons tanpa data.id -> invalid_response; apiKey salah format -> TypeError tanpa nilai di pesan; error/pesan tidak memuat nomor, teks, token (cek string); verifyWebhook: valid, ganda secret rotasi, salah, stale (>300 s), masa depan >300 s, tepat 300 s lolos, daftar secret kosong.
2. `apps/api/src/test/wa-webhook-replay.test.ts` (pola `identity-login.test.ts`, `wa-login-reply.test.ts`): replay kiriman bertanda tangan sama persis (200, tidak ada baris/efek kedua), event id sama body beda (CONFLICT dicatat, tidak ada efek), timestamp di luar 300 s 401, rotasi (secret lama dan baru keduanya 200 di route, secret dibuang 401), phone_number_id tak terdaftar -> 200 tanpa efek, pemetaan phone_number_id ke tenant yang benar (dua tenant, nomor berbeda, tidak bocor lintas tenant), tidak ada PII (nomor/teks) di log pino. Hanya tambah yang belum tercakup test existing (cek dulu `identity-login.test.ts:452-642`, `wa-login-reply.test.ts`, `tests/adapters-contract.test.mjs`).
3. Gagal-dulu: test 1 gagal karena modul belum ada (import error sah); test 2 ditulis terhadap perilaku yang sudah ada, jadi harus hijau; bila merah, catat sebagai celah nyata untuk 6qyk.
4. Pemegang token heavy: hanya test-writer untuk run gagal-dulu: `heavy env LEGEND_TEST_FILES="src/test/messaging-kirimdev.test.ts src/test/wa-webhook-replay.test.ts" pnpm test` dari root worktree. Potongan A dan B tidak menjalankan tsc/vitest.
