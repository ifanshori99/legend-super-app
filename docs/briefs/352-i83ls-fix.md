# i83ls lanjutan: perbaikan review architect atas 5558eca2 + legend-800h1

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K (uang): satu subagent architect review di akhir.
Basis: `git worktree add .worktrees/i83ls-fix -b ws/i83ls-fix ws/i83ls-swap-charge` (5558eca2). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Temuan architect (CTO, dari baca kode, belum diuji)
1. Tinggi: `pos-order-payment.ts:897-898` `closeChargesCoveredByTender` lalu `loadSettlement` selalu null di worker: `setTableSessionSettlementLookup` hanya dipasang di `app.ts:82`, tidak di `worker-main.ts`. QRIS kasir lewat worker tidak pernah menutup charge.
2. Sedang: index unik `payment_links` `oic:%` (0229:50) + `createPaymentLink` commit sendiri (`order-recovery-charge-payment.ts:189-209`): link yatim tanpa `paymentLinkId` membuat retry 23505 selamanya. Keputusan CTO: hapus index itu; `ensureChargeLink` memakai ulang link `oic:<id>` aktif yang ada atau membatalkan yang yatim.
3. Sedang: `remainingIdr` (`pos-order-support.ts:331-338`) membatasi tender ke sisa tagihan order, jadi tender kasir tidak pernah berisi uang charge. Syarat tutup (`order-recovery-charge.ts:544-549`) hanya terpenuhi oleh sisa kredit deposit (`settlementOf` `qr-order.service.ts:2198,2207`), lalu charge ditutup `paid_at_pos` tanpa jurnal (pendapatan + PBJT hilang).
4. Rendah: hook gagal (`pos-order-payment.ts:216-235`) tanpa retry.

## Keputusan CTO
- Pastikan dulu dengan test lewat jalur nyata (`addPosTender`, `handlePosPaymentPaid`): bisakah tender kasir mencakup uang charge? Bila tidak (temuan 3 benar), hook tutup-otomatis dibuang. Celah "tagih dua kali" versi awal berasal dari tender suntikan yang tidak mungkin terjadi.
- Kerjakan legend-800h1: aksi kasir eksplisit untuk menagih charge di POS. Tender khusus charge, jurnal lewat `aj:order-charge:<id>` yang sudah ada, status `paid`, link QR dibatalkan di transaksi yang sama, urutan kunci issue → order → charge → link → intent.
- Sisa deposit tidak boleh menutup charge kecuali jumlahnya dicatat sebagai pembayaran charge dengan jurnal (pakai `depositAppliedIdr`, bukan seluruh kredit). Kalau rumit: jangan pakai deposit, charge tetap open.
- Keputusan founder tetap: Q91 selisih penuh, Q92 waive staf berizin, Q93 tutup meja biasa menunggu charge lunas/waived.
- Cek yang belum sempat: `depositCreditFor` di worker; `cancelPaymentLinkInTx` memicu refund `late_payment_on_closed_charge` untuk intent pending; guard jurnal di `accounting-auto-journal-guards.ts`.

1. Test gagal-dulu tiap butir.
2. Typecheck dan test terarah lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Architect review di akhir, temuan nyata dibetulkan.
3. Commit, push, `bd comment legend-i83ls legend-800h1`, update `docs/PROGRESS.md`.

Migrasi: ubah 0229 di tempat (masih sementara, belum digabung). Edit pakai tool Edit, bukan sed. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, test gagal-dulu, temuan architect.
