# Merge train batch46

Peran: merge train (baca `~/.agents/team/roles/` berkas merge train/engineer dan "Paralel dulu" di TEAM.md).
Basis: ref `milestone/m1` d07b6cf8 (batch45). Prosedur sama dengan brief 306/303: `--no-ff`, `db:generate` kosong sesudah tiap merge, gate lewat `heavy` (typecheck, `pnpm test` penuh, e2e), reviewer untuk hunk konflik, lalu majukan ref m1. Jangan checkout di folder utama; kerja di worktree sendiri `.worktrees/merge-batch46`. Jangan push.

## Urutan merge (urut `when` migrasi)
Cabang bertingkat: merge ujung rantai saja (sudah berisi induknya), cek SHA induk ada di ujung.
1. `ws/ts50-customer360` 4448daef: 0209_crm_feedback_segments
2. `ws/3zd1-tiers-expiry` 1f4c35ba: 0210_loyalty_tiers_referrals
3. `ws/gateway-plan-revoke` e77bf057 (berisi `ws/gateway-adapter-duitku` 053871ba): 0211_platform_payment_gateways
4. `ws/hris-loan-perm` 440578e5: tanpa migrasi
5. `ws/loyalty-training-lookup` 87474499: tanpa migrasi
6. `ws/swap-stock` b6a38096 (berisi failed-item b339a57c, az-flow-y d83ed9c7, swap-kitchen 2456da3c): 0214_failed_item_recovery
7. `ws/facility-entitlements` 70b8e21e: 0215_facility_entitlement_ledger
8. `ws/kitchen-load-admin` 8060d96c (berisi order-pacing 48fdb244): 0216_order_pacing
9. `ws/storage-wire` 62ef1e11 (berisi hris-attendance 704ecc3d): 0217_hris_attendance
10. `ws/wifi-edge` 8b57852f (berisi wifi-quota d05c1898; basisnya 3zd1, jadi 0210 sudah ada dari langkah 2): 0218_wifi_quota_engine
11. `ws/flaky-ten06` 26734fbf (legend-23tbw, hanya test: kuota outlet fixture di `platform-org-api.test.ts`)

Tidak termasuk batch ini: `ws/profit-share` (0219, review belum selesai) dan `ws/ws01-k2l` (0204 bentrok, thread belum selesai). Keduanya batch47.

## Migrasi
m1 berakhir di idx 208. Penomoran akhir rapat tanpa celah sesuai urutan merge: 0209 crm, 0210 loyalty tiers, 0211 gateways, 0212 failed_item_recovery, 0213 facility_entitlement_ledger, 0214 order_pacing, 0215 hris_attendance, 0216 wifi_quota_engine. Ganti nama berkas .sql dan snapshot, `tag` dan `idx` di `_journal.json`, sambung ulang `prevId` tiap snapshot ke snapshot sebelumnya, `when` tetap naik. Cari rujukan nama migrasi lama di kode, test, docs (runbook, release notes) dan ganti. Sesudah tiap merge: `db:generate` harus kosong dan migrasi jalan dari DB kosong.

## Konflik
`docs/PROGRESS.md` dan berkas daftar (index, router, permission list): gabungkan keduanya. Konflik logika lain: berhenti, lapor CTO dengan nama cabang dan berkas.
Test hitungan yang naik karena gabungan (seperti chart count di batch45) boleh dibetulkan, catat di laporan.
Test penuh lewat `heavy pnpm test` dari root (bukan `--filter api`, itu tanpa DB sekali pakai). Flaky dikenal: TEN-06 (dibetulkan langkah 11) dan `e2e-az/az-r-whitelabel.test.ts` 409 kontak admin dipakai (legend-5tmye, belum dibetulkan). Bila hanya itu gagal, ulang berkas itu saja dan catat, jangan ulang gate penuh.

## Catatan rilis
Tambah bagian batch46 di `docs/release-notes-m1-migrations.md`: daftar migrasi baru, hal yang perlu backfill/konfigurasi (gateway Duitku butuh kunci sandbox dari founder, belum ada; storage PDF ditolak 503 di production selama scanner noop; jurnal koreksi otomatis), dan perilaku berubah (krvk7 tanpa backfill role kustom tidak di batch ini).

## Sesudah gate
Hapus worktree yang cabangnya sudah di m1 dan bersih (tanpa `--force`), `git branch -d` cabangnya, `git worktree prune`. Jangan hapus worktree thread lain (profit-share, ws01-k2l, k2l-2, mz15j, oeqme, 8s992). Daftar berkas untuk alat: berkas sementara + `xargs`, jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain.

## Laporan
Sekali di akhir: SHA m1 baru, tabel penomoran migrasi lama ke baru, konflik, angka gate (file/tes api, root, e2e), temuan reviewer, perbaikan di luar konflik, worktree dihapus, ruang disk.
