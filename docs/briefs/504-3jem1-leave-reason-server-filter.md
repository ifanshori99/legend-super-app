# 504 Temuan 501 no.4: filter alasan cuti di server (3jem1)

Peran: engineer (~/.agents/team/roles/engineer.md). Cabang: ws/3jem1-hr-leave-review-ui (970c9406), kerjakan di worktree sendiri. Tidak ada migrasi.

Masalah (Codex 501 P2): apps/web/src/features/hr-leave-clockin-review/api.ts:39 mengambil 500 entri lalu memfilter alasan cuti di klien, sehingga kasus lama di luar 500 hilang dari antrean review.
Keputusan CTO: filter alasan di server (parameter query di endpoint API yang dipakai, cakupan izin tetap) + pagination di klien sampai nextCursor habis (atau infinite list dengan "muat lagi").

Cara kerja: spawn test-writer (API: filter alasan + cursor; web: semua halaman termuat) dan implementer API + implementer web paralel, reviewer sonnet di akhir. Fail-first wajib. Gate: tsc api (heap 6144) dan web, eslint, prettier, test terkait lewat `heavy`.
Selesai: commit + push ke origin/ws/3jem1-hr-leave-review-ui. Laporan: sha, bukti gagal-dulu, angka subagent (total, puncak, pemegang heavy).

Langkah 0: repo di /Users/ifanshori99/Projects/legend super app/legend. Buat worktree sendiri: `git -C <repo> fetch origin ws/3jem1-hr-leave-review-ui && git -C <repo> worktree add .worktrees/3jem1-filter ws/3jem1-hr-leave-review-ui` (cabang sudah ada; jangan buat cabang baru). Kerja hanya di worktree itu, PORT dan nama DB sendiri.
