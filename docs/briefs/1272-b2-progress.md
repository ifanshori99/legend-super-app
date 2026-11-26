# B2 legend-wasr7.21 progres

Brief: `legend/docs/briefs/1272-b2-brief.md`. Cabang `ws/1272-b2`, migrasi 0541 saja.

## Rencana
1. Migrasi 0541 + skema `db/schema/edc-bridge.ts`:
   - `edc_bridge_devices` (id ULID, tenant, outlet, label, token_hash unik, created_by, last_seen_at, revoked_at), lookup pra-auth lewat `app.edc_bridge_resolve_token(hash)` (SECURITY DEFINER, pola `app.mcp_resolve_token`).
   - `edc_bridge_terminal_leases` (satu baris per terminal: device_id, lease_id, issued_at, ttl_ms).
   - `edc_bridge_commands` (commandId, tenant, outlet, terminal, device, lease, op, trace, sent_at, result_outcome, result_at, release_sent_at): pencocokan `result` dan sumber `sale_record_release`.
   - `payment_edc_terminals`: `connection_kind` (`bridge`|`bca_cloud`, default bridge), `bridge_device_id` (FK tenant+outlet+device), `link_port`, `link_baud_rate`.
   - BRI: `edcBankSchema` + semua CHECK `bank IN (...)` (terminal, edc_transactions, settlement CSV) + enum admin.
2. Izin: pakai `payment.edc.manage` yang sudah ada (tidak menambah izin baru).
3. Agent: `registry.get(bank, target?)` (target = baris terminal) supaya provider dipilih per terminal; `NotSentError` diekspor (`edcNotSentError`) supaya provider jembatan yang tidak mengirim apa pun -> `failed` "tidak pernah dikirim". Aturan uang lain tidak diubah.
4. `edge/edc/bridge-codec.ts` (antarmuka isi pesan bank + codec simulator JSON, ditolak di production), `bridge-provider.ts` (EdcProvider di atas sesi WSS), `cloud-runtime.ts` (satu agent cloud, sesi per perangkat, lease DB, perpanjang 30 s, ttl 120 s, kunci outlet lewat `agent.start`), `resolver.ts` (edge dulu, lalu cloud).
5. `routes/edc-bridge.routes.ts`: WSS `/api/edc-bridge` (Bearer token perangkat), router HTTP `/api/edc-bridge/devices` (daftar/terbitkan/cabut/tugaskan terminal).
6. `sale_record_release`: dipanggil sesudah impor settlement X2 untuk trace yang `matched`.
7. Test gagal-dulu: `src/test/edc-bridge-cloud.test.ts` + emulator `src/test/helpers/edc-bridge-emulator.ts`.

## Status
- Sudah (7942a1552): migrasi 0541 (tabel perangkat/lease/command, kolom terminal, BRI, RLS, `app.edc_bridge_resolve_token`), `registry.get(bank, terminal)` + `edcNotSentError` di agent, `bridge-codec.ts`, `bridge-provider.ts`, `cloud-runtime.ts`, `resolver.ts`, services request/payment-options pakai resolver, release sesudah impor X2, `routes/edc-bridge.routes.ts` (HTTP perangkat + WSS), wiring server.ts dengan flag baru `EDC_BRIDGE_ENABLED` (EDC_AGENT_ENABLED dijaga mati di single-vm oleh check-refund-flag.sh, jadi tidak dipakai ulang).
- Sedang: typecheck api, lalu test `src/test/edc-bridge-cloud.test.ts` + emulator `src/test/helpers/edc-bridge-emulator.ts`.
- Sisa: test syarat wajib, catatan "Provider cloud" di `docs/design/edc-bridge-protocol.md`, pra-gate (prettier/eslint/typecheck web), kode pasang 8 karakter (belum; token diterbitkan langsung).
