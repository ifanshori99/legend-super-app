# 1164 brief (engineer, 19 Nov)

Cabang: `ws/1164-payout-recurring-approval`. Tanpa migrasi. Jangan sentuh: `payroll-payout-gl.service.ts`, `payment-admin*`, `order-given.ts`, `accounting-journal*`. Tingkat K (uang + akses): aturan restriktif, bila ragu batasi pembayaran. Tes terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari `apps/api`/root worktree (lihat CLAUDE.md "Test terarah"). Tes harus gagal dulu karena sebab yang benar.

## Kartu A: legend-q2nkl (recon payout)

File: `apps/api/src/services/payroll-payout-recon.service.ts`, `apps/api/src/db/index.ts` bila perlu. Prasyarat e7d803748 sudah di base.
Masalah: waiter yang kena `lock_timeout` 55P03 melewati operasi tanpa observasi; slip bertahan di catatan terakhir (bisa 'ok') selama pemegang lock macet.
Maunya: waiter timeout tidak melewatkan recon (catat bacaan unreadable/hold lewat jalur yang tak butuh lock yang sama, ATAU batasi umur 'ok' terakhir) dan tidak membayar ganda. Plus listener error per koneksi di `db/index.ts` + test `pg_terminate_backend` pada pemegang lock.

## Kartu B: legend-ww562 (DOIT recurring)

File: `apps/api/src/services/payment-recurring.service.ts` (~~:118 `defaultClientFor`), `apps/api/src/config/env.ts` (~~:268), rute `payment-recurring.routes.ts:34`.
Maunya: cek `DOIT_RECURRING_ENABLED` juga di service: throw `SERVICE_UNAVAILABLE` bila flag mati. Test: flag mati, pemanggil service langsung (job/consumer) ditolak. P3 opsional: env.ts:268 blankToUndefined.

## Kartu C: legend-k8g62 (platform-approval)

File: `apps/api/src/services/platform-approval.service.ts` (~:1357).
Maunya: muat ulang peran/jangkauan approver sesudah `lockChain`. Test: peran dicabut di antara cek awal dan lock -> approval ditolak.

## Keputusan engineer (tanpa migrasi)

- Kartu A: `observe` butuh advisory lock yang sama dengan pemegang macet, jadi 'error' tak bisa ditulis oleh waiter. Tanpa migrasi: waiter yang kena 55P03 menaikkan flag `app.payout_recon_flag` (tanpa advisory lock, kolom reason teks bebas) dengan reason baru `evidence_read_locked` untuk tiap terminal item operasi itu (state file baru `"locked"` di `FileState`, `evaluate` -> `addAll("evidence_read_locked")`). Flag menahan slip sampai ditutup dua-orang. Tambah ke tipe `PayoutReconReason`. Ubah T3 di `payroll-payout-89xse-storage-timeout.test.ts` ("tanpa observasi") hanya bila bertentangan; jelaskan.
- Kartu A, db/index.ts: tambah `pool.on("connect", c => c.on("error", ...))` log tanpa data pribadi, agar backend dimatikan (`pg_terminate_backend`) pada koneksi yang sedang dipinjam tidak jadi unhandled 'error'.
- Kartu B: flag + rute sudah ada di worktree (cherry-pick 64d5d345e dari m1; base belum memuatnya). Tambah gerbang di service.

## Ronde 2 (keputusan founder via CTO, 19 Nov)

### Kartu D: DOIT stop selalu boleh (legend-ww562 lanjutan)

- Flag `DOIT_RECURRING_ENABLED` mati: pause dan cancel langganan DIIZINKAN (arah membatasi pembayaran). Yang diblokir hanya create, resume, dan charge (penagihan). Gerbang di `defaultClientFor` (purpose "bill" diblokir, "stop" lolos) harus disesuaikan: pause/cancel memakai jalur stop.
- Bila panggilan ke DOIT gagal (termasuk flag mati/klien tak tersedia), catat status lokal `cancel_pending` dan jangan menagih lagi (tak ada charge baru untuk langganan itu). Cek status yang sudah ada dulu; bila `cancel_pending` belum ada di skema/enum, JANGAN migrasi: pakai mekanisme status yang ada dan lapor.
- Test: flag mati -> cancel/pause lolos, create/resume ditolak, kegagalan DOIT -> cancel_pending dan tidak ada tagihan baru. Perbarui `payment-recurring-ww562-service-flag.test.ts` (sekarang menegaskan pause/cancel ditolak: itu keputusan lama).

### Kartu E: legend-jsrcs sisi DB (migrasi 0706, cadangan 0707)

- Penutupan dua-orang (`app.payout_recon_clear_approve`) ditolak untuk flag reason `evidence_read_locked:%` selama pemegang advisory lock operasi itu (`payout_recon_evidence_observe:<tenant>:<operation>`, hashtextextended(...,0)) masih memegangnya di hari itu (cek `pg_locks`). Salin badan fungsi terbaru, tambah cek itu. Journal idx/tag 0706. Daftarkan di `data-import-registry.test.ts` dan tes cakupan yang terkait. Migrasi ditulis tangan; `db:generate` sesudahnya harus kosong.

### Kartu F: SO 1160 P2 (platform-approval cancel waktu)

Detail: `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-approval-waktu-r2-1160.md` (temuan P2). `resolveApprovalChainOutcome` (`platform-approval.service.ts` ~~:795-830) menunggu `lockChain` lalu membandingkan deadline dengan `input.now` lama; `cancelApprovalRequest` (~~:850) dan `cancelOwnRequest` (~:1030) sama. Fix: sesudah chain lock, segarkan waktu: `max(jam pemanggil, jam server)` (pola 1151 di decideApprovalRequest: `checkAt`), pakai untuk evaluasi tenggat dan fakta transisi (`updatedAt`, event, audit). Test barrier dua koneksi (pola `platform-approval-sole-owner-lock-time.test.ts`): lock chain-head ditahan sampai sesudah tenggat tanpa UPDATE -> cancel requester 409 CONFLICT, tanpa status/event `cancelled`; kontrol lepas sebelum tenggat tetap sukses. File tes baru `platform-approval-cancel-lock-time.test.ts`.
