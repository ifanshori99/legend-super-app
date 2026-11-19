# 1142 Second opinion kas ronde 9 (fix 1140 atas SO ronde 8)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`, kecualikan `':!**/meta/*snapshot.json'`): `git diff eab61aa7a..origin/ghostex/d158b041` (head bb1f85ab6). Konteks penuh: `git diff origin/milestone/m1...origin/ghostex/d158b041`.
Brief: `docs/briefs/1140-fix-so-kas-ronde8.md`. Ronde 8: `docs/qa/second-opinion-kas-ronde8-1138.md`.
Isi: reversal jurnal kasbon/reimburse yang sumbernya masih disbursed/dibayar -> 409 (sumber + snapshot, termasuk legacy tanpa snapshot); impor konfigurasi mengunci chart sebelum `tenants FOR UPDATE`, entity baru try-lock lalu tolak "ulangi impor"; nominal NULL/hilang/bukan angka/<=0 = baris penghalang gerbang SQL dan cadangan tertahan, dicek sebelum filter neto; gerbang menghitung baris reversal.
Diterima CTO/founder (jangan dilaporkan): semua yang diterima di brief 1066, 1074, 1089, 1105, 1115, 1138; urutan kunci impor pajak/service-charge (bead terpisah).
Cari: tiga temuan ronde 8 benar tertutup; reversal parsial/berantai/lintas entity yang masih membuka kas; jalur reversal lain (API lain, jurnal manual, koreksi) yang melewati guard; try-lock yang bisa dilewati; gerbang SQL yang lolos padahal data buruk; test yang melemahkan jaminan uang.
Hasil: tulis `docs/qa/second-opinion-kas-ronde9-1142.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
