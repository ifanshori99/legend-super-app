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
- Sudah (4e99b6681): migrasi 0541, agent `registry.get(bank, terminal)` + `edcNotSentError`, `bridge-codec.ts`, `bridge-provider.ts`, `cloud-runtime.ts`, `resolver.ts`, services pakai resolver, release sesudah impor X2, `routes/edc-bridge.routes.ts` (HTTP + WSS), server.ts + flag `EDC_BRIDGE_ENABLED` (EDC_AGENT_ENABLED dijaga mati di single-vm), BRI di enum/CHECK + alias CSV kosong, catatan "Cloud" dan "Provider cloud" di `docs/design/edc-bridge-protocol.md`.
- Test: `src/test/edc-bridge-cloud.test.ts` 11/11 lulus 3x berturut (run pertama b2-6 timeout 5 s menunggu command sekali, waitFor dinaikkan ke 15 s).
- Sedang: regresi (e7, runtime-867, agent, contract, rls, provision-roles-audit) + typecheck api/web.
- Sisa / di luar B2: kode pasang 8 karakter + batas salah per IP (protokol "Token perangkat"), UI BRI di `edc-panel.tsx` (B4), codec bank (B5), `bca_cloud` (B5a).
