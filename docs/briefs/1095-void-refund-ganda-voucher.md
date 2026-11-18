# Brief: engineer — void/refund ganda + voucher (2 kartu, tingkat K uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`, memuat 1042 eab583b4f/23a0084bb). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Migrasi diharapkan tidak ada; bila perlu, rentang 0706-0707 dengan `--full`. Cabang: `ws/1095-void-refund-ganda-voucher`.

## Kartu
Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`. Baca `bd show` tiap kartu untuk AC.
1. `legend-5g9sn` refund kasir (`refundPosOrder`) harus menghitung voucher. Ruang refund = dibayar − refund POS − voucher maaf pesanan − refund pemulihan hidup. Port logika dari `ws/rat9r-followups`: 2c8843940, 142a40371 (`order-given.ts`, batas per baris), test 3f5c50aed (`pos-refund-voucher-cap.test.ts`). JANGAN merge cabang itu: cabangnya basi (66 komit, ditahan bersama pti5r). Keputusan CTO 11 Nov tetap berlaku: `REFUND_NOTHING_DUE`, 422 kalau ada tagihan selisih, kekurangan dicatat audit.
2. `legend-aja6g` (1042 F3, W3b satu jalur refund per pesanan): refund ORD-09 di `payment_refunds` (`order_issue_id`, status ≠ failed, termasuk antrean manual saat refund otomatis mati Q45) harus saling eksklusif dengan void edge (`edge/order-ingest.ts`, alasan baru `void_refused:ord09_refund_exists`), void cloud, dan refund kasir. Arah sebaliknya: refund ORD-09 (`order-recovery-refund.ts`) ditolak 409 kalau pesanan sudah di-void (cloud/edge/event diparkir) atau sudah direfund kasir.

## Aturan
- Jangan sampai rugi: tiap kartu wajib punya test bahwa tamu tidak menerima lebih dari yang dibayar dan outlet tidak rugi, di dua urutan, bersamaan (dua permintaan berlomba), dan pada replay edge. Juga tenant/outlet lain.
- Kunci: ikuti urutan yang sudah ada (issue lalu order; void edge mengunci `orders` FOR UPDATE). Architect wajib memeriksa deadlock.
- Ruang tabrakan: JANGAN sentuh berkas ws/1072 (`payment-refund*.ts`, `payment-webhook.service.ts`, `payment-provider-*`, `refund-recon-hold.service.ts`, `reservation-deposit-credit.ts`). Baca `payment_refunds` lewat helper baru di berkas baru. `pos-order-corrections.ts` dan `pos-order-support.ts` juga diubah `ghostex/so996-f2-f3-charge-void-split` (batch92): edit sekecil mungkin (panggil helper di berkas baru), lalu cek `git merge-tree` terhadap so996 sebelum lapor.
- Bila ragu: pilih yang menolak, catat untuk CTO. `legend-eajpb` (voucher maaf dibatasi nilai dibayar) di luar cakupan; laporkan kalau port 5g9sn menyentuhnya.

## Pembagian paralel
- Explore (2): (a) jalur uang kembali per pesanan dan kuncinya (refund kasir, void cloud/edge, ORD-09, voucher maaf); (b) diff rat9r 5g9sn vs m1 sekarang.
- test-writer (1): gagal-dulu `refund-1095-*` untuk tiap pasangan jalur.
- implementer: satu untuk port 5g9sn, satu untuk guard aja6g (berkas terpisah).
- test-runner: pemegang token heavy (test terarah, `single-refund-lane-1042` + regresi refund POS, typecheck API sekali).
- architect (effort xhigh, uang): satu review atas diff akhir (interleaving, kunci, jangan rugi).

## Bukti selesai
Test 1095 merah di m1 dan hijau di head, `single-refund-lane-1042` + `pos-936-so-refund` + `order-recovery-refund` hijau, typecheck API lulus, `db:generate` kosong, architect tanpa P0-P2 terbuka.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`. Jangan akhiri giliran untuk "Menunggu" (founder Q10).

## Sebelum melapor
Pra-gate AGENTS.md. Commit di cabang `ws/1095-void-refund-ganda-voucher`, push tanpa `--force`.

## Laporan
Hasil per kartu, aturan uang baru, bukti, berkas, commit, cabang, hasil merge-tree vs so996, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
