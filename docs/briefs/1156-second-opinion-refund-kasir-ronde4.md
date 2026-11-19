# 1156 Second opinion refund kasir ronde 4 (fix SO 1145)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`): `git diff 3bf621e86..origin/ws/1095-void-refund-ganda-voucher` (head 7fba91ddb). Ronde 3: `docs/qa/second-opinion-refund-kasir-ronde3-1145.md`.
Isi: refund finance mengunci pesanan yang dibayar intent (urut id) sebelum intent; urutan kunci issue -> orders -> intent -> charge; ruang dibaca ulang di bawah kunci; 422 `REFUND_OVER_ORDER_ROOM` menggantikan 409 `REFUND_INTENT_IN_QR_SALE`. Batas per baris chain swap: dibayar chain = bagian baris asli + charge hidup; keluar = voucher + ORD-09 + refund kasir; ORD-09 baris pengganti dan refund charge dibatasi; toleransi pembulatan ORD-09 chain 3 IDR, refund charge 0.
Sedang dikerjakan (jangan dilaporkan): ORD-09 promo baris biasa melebihi pro-rata (legend-wpn5v), void lewat kas sesudah ORD-09 (legend-4yez0), layar finance kode 409 lama.
Cari: total keluar melebihi yang dibayar (voucher, ORD-09, refund kasir, refund finance, refund gateway, void) dalam urutan apa pun dan bersamaan; deadlock karena urutan kunci baru vs jalur lain (webhook refund, payout, kas); refund sah yang kini salah ditolak; lintas tenant/outlet.
Hasil: tulis `docs/qa/second-opinion-refund-kasir-ronde4-1156.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
