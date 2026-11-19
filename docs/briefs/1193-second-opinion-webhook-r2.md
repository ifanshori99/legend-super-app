# 1193 Second opinion webhook ronde 2 (delta fix 1182 atas SO 1180)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Konteks: temuan ronde 1 di `docs/qa/second-opinion-webhook-opname-1180.md`. Fix: `git fetch origin`, lalu `git diff origin/ws/1176-webhook-opname-p3...origin/ws/1182-webhook-malformed-so1180 -- apps/api` (head 9db6edfff). Bila nama base tidak ada, pakai `git merge-base` dengan `origin/milestone/m1`.
Cari: webhook malformed yang lolos atau mengubah status bayar, replay/idempotensi, tanda tangan/verifikasi yang bisa dilewati, pencatatan dana ganda atau hilang, lintas tenant, race callback vs polling.
Hasil: tulis `docs/qa/second-opinion-webhook-1193.md` di folder utama (P0-P3, berkas:baris, skenario, usul test; nyatakan tiap temuan 1180 tertutup/belum). JANGAN commit, JANGAN edit file lain.
