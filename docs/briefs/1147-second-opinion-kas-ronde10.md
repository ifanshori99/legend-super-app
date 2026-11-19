# 1147 Second opinion kas ronde 10 (fix P2 ronde 9)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`): `git diff bb1f85ab6..origin/ghostex/d158b041` (head f1f0c4987). Ronde 9: `docs/qa/second-opinion-kas-ronde9-1142.md`.
Isi: reversal kasbon yang masih `disbursed` ditolak 409 `CASH_OUT_JOURNAL_LOCKED` apa pun mapping-nya (identitas sumber, bukan neto mapping sekarang); jurnal bayar-bank yang akunnya kemudian di-remap sebagai petty cash tidak lagi ditolak.
Diterima CTO (jangan dilaporkan): semua yang diterima di brief 1142.
Cari: P2 ronde 9 benar tertutup; perubahan perilaku jurnal bayar-bank membuka uang keluar ganda atau kas tersedia palsu; sumber lain (reimburse, supplier, gaji tunai, aset tetap) yang masih bisa dibalik saat dibayar.
Hasil: tulis `docs/qa/second-opinion-kas-ronde10-1147.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
