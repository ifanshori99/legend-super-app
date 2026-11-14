# Brief: loyalty poin kebenaran uang (ws/loyalty-points-money)

Kartu: legend-29shf, legend-4frkf, legend-st2i1, legend-90na8 (`bd show <id>`).

Aturan founder: tidak ada pihak dibayar lebih, outlet tidak rugi. Test wajib membuktikan: poin tidak pernah tercipta ganda, saldo tidak negatif, idempoten saat retry dan konkuren. Ragu: pilih aturan yang membatasi, catat keputusan di komentar kartu dan laporan.

Scope: service/route/test loyalty, referral, klaim split-bill, validator terkait. Jangan sentuh payroll, payout, finance-exceptions, edge-sync, reports schedule-recipients, ops checklist, platform audit, HRIS cuti, berkas test flake.
Migrasi: hanya 0555-0556 (bila perlu), FK inline di CREATE TABLE, daftarkan di data-import-registry.test.ts.

Bukti: `LEGEND_TEST_FILES="..." heavy pnpm test`; merah di base dicatat; prettier + eslint file berubah; typecheck api (+web bila shared berubah) lewat heavy.

## Perbaikan setelah review architect (xhigh)

1. Cap grant hangus salah: `reversibleOfGrant` (loyalty-earn-consumer.ts) dan `grantLeft` (referral.service.ts ~:461) memakai `grant.unused` bila ada row expire; itu menghitung poin yang sudah DIPAKAI redeem sebagai hangus -> outlet rugi. Contoh: grant 10 (hampir hangus) + grant live 50; redeem 8 (diambil dari grant 10 dulu FIFO), 2 hangus, lalu refund penuh: harus reverse 8 (bukan 0).
   Aturan benar: bila grant punya row expire: ceiling = poin grant - total poin row expire milik grant itu (type expire, reverses_entry_id = grant.id, points negatif) - total reverse yang SUDAH diposting untuk grant itu; cap = max(0, ceiling). Tanpa row expire: seperti sekarang (hanya saldo). Tambah `expiredPoints` (jumlah -points row expire) ke `GrantState` di loyalty-expiry.service.ts (hitung di loop replay dekat baris ~271), dan teruskan poin grant + total reverse sebelumnya dari pemanggil (jalur claim: claim.points & reverse sebelumnya; jalur record: record.bookedPoints & record.reversedPoints; referral: bonus.points & `taken`).
2. Referral: reversal penuh tak pernah terpicu bila order pertama sebagian dibayar poin. `reverseReferralBonus` (consumer) harus menganggap refund PENUH bila earn record `refundedEligibleIdr >= eligibleSpendIdr` (record ada), dan kirim flag/ jumlah yang konsisten ke `reverseReferralForOrder` (referral.service.ts ~:383-394 membandingkan dengan eligible dari tabel orders, yang tidak mengecualikan bagian poin). Tanpa earn record: perilaku sekarang.
3. Refund ditolak tidak mengembalikan bonus referral: TIDAK diperbaiki (keputusan CTO, member dirugikan bukan outlet).

Tambah test: (a) redeem -> expire -> refund penuh = reverse -8 di loyalty-money-29shf-4frkf.test.ts; (b) bonus referral terpakai sebagian lalu hangus lalu void = reverse sebesar sisa non-hangus; (c) order pertama sebagian dibayar poin lalu refund penuh membalik bonus. Di loyalty-money-st2i1-90na8.test.ts. Jangan jalankan test/tsc (heavy dipegang test-runner).
