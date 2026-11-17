# 958 Recon: refund provider setelah pembayaran tercatat (K uang)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang).
Cabang: worktree-mu dari `origin/ghostex/rekonsiliasi-sisa-bank-dan-doit` (5e1f9d9fc). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0480-0484 (nomor kerja).
Kartu (`bd show <id>`; claim dulu):
- legend-7uqbs (P1): `payment.refunded` atau poller `refunded` untuk kode yang sudah kita catat (dana diparkir sebagai unallocated, atau tagihan lunas terlambat) tidak memperingatkan staf. Tulis baris audit, tandai dana parkir/pembayaran itu agar tidak bisa dialokasikan atau di-refund manual lagi, dan kirim alert ke supervisor outlet. Jangan membalik jurnal otomatis; keputusan koreksi tetap di staf.
- legend-3wwme (P3): payload `payment.refunded` yang bukan objek payment dibalas 2xx dengan catatan ditolak (bukan 500 yang membuat DOIT retry 24 jam); betulkan komentar lock di `recordUnsettledGatewayFundsInTx`.
Jangan sampai rugi: test bukti dana yang sudah di-refund provider tidak bisa dialokasikan atau di-refund kedua kali, tidak ada jurnal ganda, dan alert tercatat sekali per kejadian (webhook dan poller bersamaan).
Paralel: Explore + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu; lalu test-runner + architect xhigh bersamaan. Suite besar hanya setelah kode beku (Retro 39).
Bukti: gagal-dulu lalu hijau; test area payment/recon lewat heavy setelah commit terakhir; pra-gate AGENTS.md (prettier, eslint, text-contract bila ada teks baru, db:generate kosong, registry migrasi, typecheck API sekali); architect tanpa P1.
Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari kedua kartu. Lapor sekali di akhir.
