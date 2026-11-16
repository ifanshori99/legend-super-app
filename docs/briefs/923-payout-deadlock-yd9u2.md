# 923 Payout: deadlock catch-up unfreeze vs worker bukti historis (legend-yd9u2, P2)
Peran: engineer (baca ~/.agents/team/roles/engineer.md), Codex effort high. Area uang: perubahan sempit, hanya urutan kunci. Kuota Claude habis, jadi review architect Claude menyusul sebelum gerbang rilis; kamu wajib menjalankan satu subagent reviewer independen atas diff.
Cabang: worktree-mu dari `ghostex/920-payout-fix-so919-freeze` (d06e5a269); commit dan push tanpa force ke cabang barumu. Migrasi sementara 0663 bila perlu. Tidak merge, tidak deploy.
Temuan + usul perbaikan dan test: `git show origin/qa/second-opinion-payout-920:docs/qa/second-opinion-payout-920.md`.
Arah CTO: semua jalur mengikuti urutan terdokumentasi run -> batch (urut id) -> item -> advisory GL; worker bukti historis dan catch-up unfreeze mengambil kunci run dulu dan batch dalam urutan id yang sama. Jangan ubah aturan uang lain.
Bukti: test konkurensi deterministik (transaksi pg manual) yang memicu 40P01 di basis lalu hijau; test payout lewat heavy setelah commit terakhir; prettier, eslint, typecheck api sekali sebelum lapor.
Laporan: cabang, SHA, migrasi, test, temuan reviewer, angka subagent. Komentari legend-yd9u2.
