# Sub-brief 101: DOIT webhook retry lintas integrasi (P1, tingkat K, uang)

Worktree `.worktrees/fix-doit-webhook`, cabang `ws/fix-doit-webhook`. Path relatif `apps/api/src/`. Jangan commit. Jangan pkill/killall test. Brief induk: `docs/briefs/101-fix-doit-webhook-retry-codex.md` (di checkout utama `legend/docs/briefs/`).

## Bug (`services/payment-webhook.service.ts` ~770-820)
Insert konflik pada eventId → `loadVerifiedRow(context, event.id)`; row `received`/`failed` → `processStoredEvent(context, row, event, now, verified.secret)` dengan `event` = payload BARU dan secret integrasi penanda tangan BARU, padahal `row.integrationId` bisa milik integrasi lain (A). Integrasi B yang tahu eventId A bisa mengirim `paid` bertanda tangan kunci B dan melunasi intent outlet A. Jalur `row.payload === null` juga menimpa payload row A dengan payload B.

## Fix (kontrak)
1. Row ada dan `row.integrationId !== verified.integrationId` (bandingkan case-insensitive bila uuid): tolak. Jangan proses, jangan ubah row. Catat audit (`recordAudit`, action mis. `payment.webhook.integration_mismatch`, actorType system, before/after tanpa payload/secret) dan balas status non-sukses yang tidak membuat DOIT retry tanpa henti — ikuti konvensi file (mis. `ignored`/409 `WEBHOOK_INTEGRATION_MISMATCH`); pilih yang konsisten dengan respons lain di file, jelaskan di laporan.
2. Integrasi sama, `row.payload !== null`: proses payload TERSIMPAN (`doitWebhookEventSchema.parse(row.payload)`), bukan payload pengganti. Bila `payloadHash` beda, tetap pakai yang tersimpan.
3. Integrasi sama, `row.payload === null` (sebelumnya MALFORMED): payload pengganti boleh disimpan dan diproses (perilaku sekarang), hanya setelah cek integrasi.
4. Worker `reprocessStoredWebhookEvents` sudah memakai row.payload + secret row.integrationId; pastikan tetap begitu.

## Test (merah dulu)
File baru `test/payment-webhook-retry-integration.test.ts`, pakai helper test DOIT webhook yang ada (cari `payment-webhook*.test.ts`). Kasus: (a) serangan lintas integrasi: A event `received`/`failed`, B kirim `paid` dengan eventId sama bertanda kunci B → intent A tetap belum lunas, row tidak berubah, audit tercatat; (b) retry integrasi sama dengan payload berbeda → yang diproses payload tersimpan; (c) retry row MALFORMED integrasi sama → diproses; (d) MALFORMED row, integrasi lain → ditolak. Jalankan file di kode lama dulu: (a) harus GAGAL; catat output singkat. Lalu fix, jalankan lagi lulus.
Run satu file dari root worktree: `LEGEND_TEST_FILES="apps/api/src/test/<file>" pnpm test`.

## Bukti
Output merah-lalu-hijau, berkas berubah, ringkasan diff.
