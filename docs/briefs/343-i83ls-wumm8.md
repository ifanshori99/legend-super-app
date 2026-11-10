# legend-i83ls + legend-wumm8: tagih selisih swap; issue refund ditolak bisa dilaporkan ulang

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K (uang): satu subagent architect review. Kerjakan berurutan di satu cabang (berkas bersinggungan).
Basis: `git worktree add .worktrees/i83ls -b ws/i83ls-swap-charge ws/94q2l-impl` (b78f169c; berisi rantai item gagal, isPaidOrder, refund recovery dan reversal). Jangan checkout folder utama. Jangan push.

## A. legend-wumm8 (kecil, dulu)
Keputusan CTO: refund ditolak = final; perlu refund lagi = issue baru. Saat ini `order_issues_resolved_item_once_idx` dan `order_issues_resolved_check` menolak issue baru untuk baris yang sama. Ubah indeks parsial supaya issue yang refund-nya ditolak tidak dihitung. Test gagal-dulu: issue baru bisa dibuat setelah refund ditolak; refund ganda tetap tercegah (issue lain yang masih aktif/terbayar tetap memblokir).

## B. legend-i83ls
`bd show legend-i83ls`. Swap ke item lebih mahal yang disetujui staf lewat approval `price_correction` baru dicatat (`order_issues.price_difference_idr`, `approval_request_id`). Tagih selisihnya lewat jalur pembayaran yang ada:
1. QR pay-first: buat payment intent tambahan untuk selisih (pro-rata service + PBJT sama seperti Q85, fungsi hitung dipakai bersama `recoveryRefundSplit` bila cocok). Open bill: tambahkan ke tagihan. Order kasir: rute ke POS (audit, kasir menagih), seperti refund.
2. Idempoten per issue; tanpa tagihan ganda. Jurnal lewat jalur pembayaran yang ada (jangan buat jalur jurnal baru tanpa alasan; bila perlu, jelaskan di laporan).
3. Tamu tidak bayar selisih: perilaku yang jelas dan teraudit (swap tetap jalan, piutang tercatat atau dibatalkan staf). Pilih yang konsisten dengan model order; bila ini keputusan bisnis, tulis di laporan dengan rekomendasi.

## Umum
Migrasi bila perlu: nomor sementara 0229, `when` 1794308000000, FK inline (bukan NO FORCE/FORCE), jalan sebagai migrator non-superuser, `db:generate` kosong. Typecheck dan test lewat `heavy`. Typecheck gagal lebih dari 2 kali berturut: berhenti dan lapor. Architect review, temuan nyata dibetulkan. Commit lokal, `bd comment` kedua kartu, update `docs/PROGRESS.md`. Edit pakai tool Edit, bukan sed. Jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain. Stempel waktu pakai `date`.

## Laporan
Sekali di akhir: SHA, migrasi, test gagal-dulu, temuan architect, pertanyaan bisnis (bila ada).
