# Brief legend-tiw2h: pemanggil biasa tidak boleh melepas hold bukti error

Cabang: ghostex/d7876c20 (dasar e7d803748 = ghostex/timeout-storage-dan-lock-recon, qh11l F1 + 89xse). Migrasi 0674 BELUM landing: ubah langsung, jangan buat migrasi baru.
Temuan: `git show d3f7940cf:docs/qa/second-opinion-kas-payout-ronde3-1066.md`, P1 pertama.

## Masalah
`app.payout_recon_evidence_observe` (legend_app) hanya menolak `ok`. Setelah A(mismatch, seq10) -> clearance -> error(seq11), pemanggil biasa memanggil `observe(tenant, op, 'mismatch', hash_A)` (atau `missing` bila episode missing): seq12 sama run dengan seq10 (error diabaikan), `read_error` hilang karena baris terakhir bukan error, fingerprint kembali = fingerprint clearance lama, slip lepas tanpa pembacaan storage.

## Aturan (restriktif, keputusan CTO)
Pemanggil selain role `legend_payout_recon` tidak boleh mengubah slip dari hold ke lepas sama sekali. Hanya pembacaan recon yang segar yang boleh.

## Desain
1. `app.payout_recon_evidence_observe_internal` dapat parameter ke-5 `p_by_recon boolean`. Di dalam internal, SETELAH advisory lock dan SETELAH membaca observasi terakhir (cek harus di dalam lock, bukan di wrapper: race error masuk di antara cek dan insert):
   - `NOT p_by_recon AND p_state = 'ok'` -> PAYOUT-92 (42501) (pertahanan berlapis; wrapper tetap menolak lebih awal).
   - `NOT p_by_recon AND v_last_state = 'error' AND p_state IN ('missing','mismatch')` -> PAYOUT-92 (42501) "a problem read after a read error is recorded by the reconciliation role only". Cek ini sebelum jalan pintas "state sama dengan terakhir" dan sebelum insert.
   - `error` dari pemanggil biasa tetap boleh (hanya menahan).
2. Wrapper `observe` (legend_app): memanggil internal dengan `p_by_recon := false`.
3. `observe_ok` (recon role): internal dengan `true`.
4. Fungsi baru `app.payout_recon_evidence_observe_difference(p_tenant uuid, p_operation uuid, p_state text, p_observed_sha text)`: hanya untuk role `legend_payout_recon` (REVOKE FROM PUBLIC, legend_app; GRANT ke legend_payout_recon), menerima state `missing`/`mismatch` saja (selain itu PAYOUT-92), memanggil internal dengan `true`. Pola sama dengan `observe_ok` (SECURITY DEFINER, search_path pg_catalog, pg_temp, owner legend_payout lewat SET ROLE di migrasi).
5. Layanan recon (`payroll-payout-recon.service.ts`): bungkus `SET LOCAL ROLE legend_payout_recon` yang ada di `recordReadOk` jadi helper pribadi; tambah `recordProblemRead(tx, tenantId, operationId, state: 'missing'|'mismatch', sha)` yang memakai fungsi `_difference`. Di loop baca (sekitar baris 2061-2065): `ok` -> recordReadOk; `missing`/`mismatch` -> recordProblemRead; `error` -> tetap `app.payout_recon_evidence_observe` (wrapper). Peran dikembalikan sama seperti recordReadOk.
6. Audit provisioning `apps/api/src/db/provision-roles.ts` (assertReconRoleReachedOnly sekitar baris 990): daftar fungsi yang tidak boleh dieksekusi login/legend_app/public ditambah `_difference` dan signature `_internal` 5 argumen `(uuid, uuid, text, text, boolean)`. Pastikan `to_regprocedure` memakai signature yang benar. Periksa tempat lain yang menyebut signature `_internal` (grep di src, scripts, docs) dan perbarui; `src/db/role.test.ts` (OBSERVE/INTERNAL/OK konstanta sekitar baris 364-470) diperbarui dan diberi kasus `_difference` (tidak bisa dieksekusi login/legend_app/public, bisa dieksekusi lewat SET ROLE).
7. Komentar kepala 0674 (butir 5) dan teks `data-import-registry.test.ts` (baris ~304) diperbarui menyebut aturan baru. Pesan komentar migrasi dan kode: Inggris, pola yang ada.
8. FK pra-gate AGENTS.md: tidak ada tabel baru, tidak ada `ADD CONSTRAINT` baru.

## Pembagian file (tidak bertumpuk)
- implementer: `apps/api/drizzle/0674_payout_qh11l_read_error_hold.sql`, `apps/api/src/services/payroll-payout-recon.service.ts`, `apps/api/src/db/provision-roles.ts`, `apps/api/src/db/role.test.ts`, `apps/api/src/test/data-import-registry.test.ts`.
- test-writer: file test baru `apps/api/src/test/payroll-payout-tiw2h-recon-only-release.test.ts` (fixture mengikuti `heldByError()` di `payroll-payout-1057-clearance-stale-evidence.test.ts:1466` dan `observeOwn` :256) DAN penyesuaian `payroll-payout-1057-clearance-stale-evidence.test.ts`, `payroll-payout-89xse-storage-timeout.test.ts`, `payroll-payout-1038-evidence-clearance.test.ts` hanya bila ada test yang sah memanggil wrapper dengan mismatch/missing SETELAH error (harus lewat helper recon `recordProblemRead` sekarang). Jangan melemahkan assertion.

## Test wajib (gagal-dulu terhadap e7d803748 sebelum perbaikan; sebab gagal harus benar: slip lepas, bukan setup)
a. heldByError, lalu `observeOwn(op, 'mismatch', sha(BYTES_A))` tanpa baca storage -> ditolak PAYOUT-92, slip tetap tertahan (fingerprint dan status slip sama, tidak ada baris observasi baru).
b. Pola `missing -> clearance -> error -> observeOwn missing` -> ditolak, slip tetap tertahan.
c. Setelah ditolak, jalur recon segar (recordProblemRead mismatch A identik / `missing`, lalu bukan `ok`) boleh mencatat; dan `recordReadOk` tetap melepas ke clearance lama (perilaku F1 yang sudah ada) — tunjukkan hanya recon yang segar yang melepas.
d. Race: transaksi pemanggil biasa menunggu advisory lock, error masuk dulu, lalu pemanggil biasa mencoba mismatch A: ditolak (cek di dalam lock). Bila terlalu rumit untuk dua koneksi, cukup bukti SQL: panggil internal lewat peran pemilik tidak perlu; yang penting cek ada setelah lock (periksa dengan membaca definisi fungsi `pg_get_functiondef` mengandung urutan lock lalu cek).
e. Pemanggil biasa tetap boleh `error`, dan `missing`/`mismatch` bila observasi terakhir BUKAN error (hanya menahan; slip tidak lepas, fingerprint berubah ke episode/seq baru).
f. `_difference`: legend_app tanpa SET ROLE -> permission denied; dengan state `ok`/`error` lewat recon role -> PAYOUT-92; mismatch tanpa sha -> PAYOUT-68.

## Perintah
- `heavy pnpm worktree:setup` bila node_modules belum ada.
- Test terarah: `LEGEND_TEST_FILES="src/test/payroll-payout-tiw2h-recon-only-release.test.ts src/test/payroll-payout-1057-clearance-stale-evidence.test.ts src/test/payroll-payout-89xse-storage-timeout.test.ts src/test/payroll-payout-1038-evidence-clearance.test.ts src/test/data-import-registry.test.ts src/db/role.test.ts" heavy pnpm test` (dari `apps/api` atau root sesuai CLAUDE.md; hanya satu run sekaligus, token heavy dipegang agent utama).
- Satu panggilan Bash = satu perintah sederhana.
