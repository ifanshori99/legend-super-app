# 1138 Second opinion kas ronde 8 (fix 1118 + 1132 atas SO ronde 7)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`, kecualikan `':!**/meta/*snapshot.json'`): `git diff 5c06f743c..origin/ghostex/cek-kas-1102-pinjaman-reimburse-supplier` (head eab61aa7a). Konteks penuh: `git diff origin/milestone/m1...origin/ghostex/cek-kas-1102-pinjaman-reimburse-supplier`.
Brief: `docs/briefs/1118-fix-kas-ronde7-mapping.md`, `docs/briefs/1132-fix-kas-1118-architect-p2.md`. Ronde 7: `docs/qa/second-opinion-kas-payout-ronde7-1115.md`.
Isi: akun ganda role kas ditolak (mapping dan impor konfigurasi); poster menolak Dr/Cr akun kas yang sama; cadangan kasbon hanya lepas bila jurnal benar mengurangi kas; penahanan petty cash memakai `je.legal_entity_id`; gerbang SQL `scripts/preflight/1118-shared-cash-mapping.sql` (statement 3: kas didebit dan dikredit sekaligus) gagal-tutup saat kolom/tabel hilang.
Diterima CTO/founder (jangan dilaporkan): semua yang diterima di brief 1066, 1074, 1089, 1105, 1115; gerbang 1118 didaftarkan ke runner release-gates saat landing bersama 1100.
Cari: temuan P1/P2 ronde 7 benar tertutup; cadangan kasbon lepas tanpa kas berkurang (reversal, jurnal Dr/Cr akun lain yang sama-sama role kas, entity berbeda, impor konfigurasi yang melewati validasi); kas 1102 tercatat tersedia melebihi saldo; gerbang SQL yang lolos padahal data buruk (NULL, tenant lain, akun nonaktif); lintas tenant/entity.
Hasil: tulis `docs/qa/second-opinion-kas-ronde8-1138.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
