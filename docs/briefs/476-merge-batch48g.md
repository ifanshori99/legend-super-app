# Brief: merge train batch48g ke milestone/m1

Peran: merge train (`~/.agents/team/roles/` merge train / engineer.md). Ikuti cara batch48f (brief 458) yang kamu kerjakan: worktree `.worktrees/merge-batch48g`, cabang `ws/merge-batch48g` dari `origin/milestone/m1` (89540326), `--no-ff` per cabang, renumber migrasi, gerbang, architect xhigh atas migrasi gabungan + konflik file uang, fast-forward push m1 tanpa force.

## Cabang (urutan saran)
1. `origin/ws/ongp7-identity-test-isolation` 07525cf5 (ongp7 + mjcl0, test saja)
2. `origin/ws/vqvuj-baa-wa-confirm` 097a0aee (e2e baa)
3. `origin/ws/9h2oj-wa-reset` + `origin/ws/9h2oj-tests` + `origin/ws/ur82k-lupa-pin-ui` (founder setuju layar lupa PIN, Q3 11 Nov)
4. `origin/ws/5nt2z-leave-partial` 3a3750ed (9y6ri + 5nt2z; Codex cuti x0avw sudah di dalamnya? cek `git log`; bila belum, tahan dan lapor)
5. `origin/ws/2qq-hpp-recompute` 1258dec7 (husxd + i8ou8 Codex fixes; migrasi 0278)
6. `origin/ws/rat9r-followups` 065bc81c (refund: rat9r, ti19m, eajpb, 5g9sn, pqm3t, hhm5m; migrasi 0235 bentrok, renumber)

JANGAN masukkan (ditahan): dheu/463, kai, 6c6, bz9h, 6pha, 97p, 24318.

## Wajib (legend-ouevv)
Nilai `when` di `_journal.json` bentrok antar cabang (0278, 0285, 0288 = 1794331000000). Beri `when` unik naik untuk setiap migrasi baru setelah migrasi tertinggi di m1, dan pastikan snapshot drizzle tiap migrasi sehingga `db:generate` kosong. Tulis peta renumber + when di laporan. Tutup legend-ouevv bila selesai.

## Gerbang
Typecheck semua paket, `pnpm lint`, vitest API penuh + root penuh (sekali, lewat heavy, satu test-runner), e2e termasuk spec mock kmndq bila ada. Gagal warisan: bandingkan dengan m1 89540326, catat di kartu. Test file uang (refund, HPP) wajib hijau.

## Laporan
Tabel cabang + sha, peta migrasi, hasil gerbang, kartu ditutup (tutup kartu semua cabang yang masuk), angka subagent. Gunakan daftar file + xargs, bukan array zsh, di perintah shell.
