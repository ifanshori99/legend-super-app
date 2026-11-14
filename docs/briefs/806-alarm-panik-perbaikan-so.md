# 806 Perbaikan second opinion alarm panik (tingkat K, akses dan keselamatan orang)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Model Opus 5.5 (desain akses/keselamatan).
Basis: worktree dari `origin/ws/panic-push-registration` (e241e9476, migrasi 0375); commit ke cabang itu dan push.
Laporan: `docs/qa/second-opinion-alarm-panik.md` (repo utama /Users/ifanshori99/Projects/legend super app/legend). Kerjakan semua P0-1..P0-4 dan P1-1..P1-3 sesuai saran dan usul test di laporan. Temuan yang menurutmu salah: buktikan dengan test atau kode, tulis alasannya di laporan, jangan diam-diam dilewati.
Prinsip: alarm lebih baik terkirim dua kali daripada tidak sampai; tetapi tidak boleh sampai ke akun/tenant/outlet yang salah. Batas langganan tidak boleh menyingkirkan HP petugas yang sedang jaga.
Migrasi baru bila perlu: nomor 0379, laporkan (merge train akan menomori ulang).
Test gagal-dulu per temuan. Paralel: Explore, test-writer, implementer per temuan (file terpisah), reviewer.
Jangan sentuh edge, DOIT, payout, HRIS, pemindai.
Selesai: test terarah lewat `heavy` (semua test panic/push/session), pra-gate AGENTS.md (prettier, eslint, typecheck api dan web lewat `heavy`), satu subagent architect effort xhigh atas diff, temuan nyata dibetulkan, commit, push. Laporan: SHA, test, hasil architect, angka subagent (total, puncak, pemegang token heavy). Uji HP nyata tetap utang gerbang rilis. Jangan merge ke m1.
