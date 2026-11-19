# 1186 Second opinion reservasi DP ronde 2 (delta fix 1178 atas SO 1171)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Konteks: temuan ronde 1 di `docs/qa/second-opinion-reservasi-dp-1171.md`. Fix: `git fetch origin`, lalu `git diff origin/ws/1163...origin/ws/1178-reservasi-so1171-fix -- apps/api` (head 15e1fa0ea). Bila nama base 1163 tidak ada di origin, pakai `git merge-base` dengan `origin/milestone/m1`.
Isi: legend-3dfri (DP terlambat sesudah cap -> batal + satu payment.paid + refund RSV-02 penuh sekali; DOIT/Duitku, callback/polling, sebelum/sesudah sweep), legend-chmz2 (filter sweep baris lama tanpa link DP), guard dua kode terlambat (refund dilewati hanya bila transaksi settle diparkir penuh sebagai fund `double_payment`), Duitku kode kedua BILL_CLOSED -> fund.
Cari: refund ganda atau melebihi uang diterima, DP hilang tanpa refund dan tanpa fund, urutan event yang lolos guard, race sweep vs callback, lintas tenant, idempotensi replay.
Hasil: tulis `docs/qa/second-opinion-reservasi-dp-1186.md` di folder utama (P0-P3, berkas:baris, skenario, usul test; nyatakan tiap temuan 1171 tertutup/belum). JANGAN commit, JANGAN edit file lain.
