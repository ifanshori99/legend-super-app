# 1133 Second opinion akses ronde 2 (1094 sesudah 1113 + 1120 + 1128)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`, kecualikan `':!**/meta/*snapshot.json'`):
- Delta sejak SO ronde 1: `git diff 4f5e3cc08..origin/ws/1128-door-check-outlet-token` (head 1fa7fddea; memuat ws/1094 f3a6ced98, ws/1120 6680b56cd, ws/1128).
- Konteks penuh: `git diff origin/milestone/m1...origin/ws/1128-door-check-outlet-token`.
- Temuan ronde 1: `docs/qa/second-opinion-akses-1094-1112.md`. Brief: `docs/briefs/1113-fix-akses-1094-so.md`, `docs/briefs/1120-akses-outlet-order-recovery-cq0u7.md`, `docs/briefs/1128-door-check-outlet-token.md`.

Periksa: (1) P1 dan dua P2 ronde 1 benar tertutup (1113: isu pesanan, availability, socket panic, voucher/swap di perangkat bersama); (2) 1120: 7 route order-recovery 403 `ACTING_STAFF_OUTLET_MISMATCH`, POST /api/apology-vouchers DENY perangkat bersama, waive/expire charge tertutup di tablet bersama; (3) 1128: door-check menolak token outlet lain sesudah QR/PIN cocok, percobaan tetap terhitung kunci `DOOR_PIN_LOCKED`, varian `shared_mode` door-check; (4) cari jalur yang masih membuka refund/void/uang keluar di tablet bersama (alias route, method lain, prefix, trailing slash, encode, HEAD/OPTIONS, wildcard allowlist); token kasir outlet A bertindak di outlet B atau tenant lain; actor dipalsukan (header, body, PIN orang lain); urutan middleware; kebocoran data pribadi; enumerasi tiket lewat beda kode galat.
Diterima CTO (jangan dilaporkan): refund di tablet bersama ditutup; batal reservasi terbuka (refund ke pembayar asli); Tanya AI KDS tertutup di tablet (legend-f7ybx); reservasi aktor pemilik sesi (legend-5f6is); strict body 422; resolve voucher/swap/waive/expire ditutup di perangkat bersama (membatasi); door-check mengembalikan `ACTING_STAFF_OUTLET_MISMATCH` untuk kredensial asli outlet lain.
Hasil: tulis `docs/qa/second-opinion-akses-1133.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
