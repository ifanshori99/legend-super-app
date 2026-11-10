# Brief: second-opinion (Codex) — urutan refund di payout guard (legend-41li5)

Tingkat K (uang). Read-only. Jangan edit, commit, push.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/payout-refund-order`, cabang `ws/payout-refund-order` (dari `f1276d2f`, ws/intent-attribution-tender). Diff: `git diff f1276d2f...HEAD`.

## Klaim yang diuji
Payout guard (`apps/api/src/services/accounting-auto-journal-guards.ts`, `refundsAt`) mengurutkan `payment_refunds` completed dengan `(completed_at, id)`. Klaim tim: bukan bug uang.
- Urutan itu total dan ketat; guard membaca baris refund, bukan jurnal. Jadi hasil (posted/parked, jumlah) hanya bergantung pada baris tersimpan, tidak pada urutan event datang atau waktu retry sweep.
- Pada satu intent, `completed_at` tidak pernah seri di produksi. Satu-satunya penulis completion (`payment-refund.service.ts` ~:533-539) memakai `lockIntentsForFact` (`payment-refund-fact-time.ts`): kunci intent `FOR UPDATE` + waktu ≥ fakta terakhir + 1 ms.
- Lintas intent (cek DP sesi, `sessionDepositAt`): completion hanya mengunci intent sendiri, jadi waktu bisa seri dan refund yang distempel lebih awal bisa commit setelah yang lain dinilai; cek itu bisa melihat lebih sedikit refund dari baris akhir. Cap saat request (`depositInUseOfIntent`) mencegah rugi nyata. Diikuti di legend-88pky (bukan diperbaiki di cabang ini).
- Test flaky di legend-9z1vm berasal dari seed test: dua refund dengan `completedAt` sama pada satu intent, dan ini tidak bisa terjadi di produksi.

## Yang berubah
Hanya komentar `refundsAt` + test:
- `apps/api/src/test/accounting-auto-journal.test.ts`, describe legend-41li5: `completedAt` sama, id tetap, dua urutan kirim → hasil sama.
- `apps/api/src/test/dp-intent-lock-race.test.ts`: dua completion dengan `now` sama → `completed_at` kedua lebih besar.

## Periksa
1. Ada jalan hasil guard berbeda karena urutan kirim, retry sweep, atau commit yang terlambat? Termasuk cek fund, cek DP sesi lintas intent, bound sale/forfeit/POS refund/void (jam sendiri, `<=` vs `<`).
2. Ada penulis `completed_at` lain yang tidak melewati `lockIntentsForFact`?
3. Perlukah tie-break diganti (misal `created_at`)?

## Laporan
Temuan nyata dengan file:baris dan skenario angka.
