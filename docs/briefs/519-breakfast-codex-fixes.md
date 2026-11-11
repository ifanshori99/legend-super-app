# 519 Fix temuan Codex 518 sarapan (uang, tingkat K)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend. Worktree ada: /Users/ifanshori99/Projects/legend super app/legend/.worktrees/breakfast-pay (cabang ws/breakfast-pay, 16bb4ce6). Pastikan bersih dan sejajar origin; ada perubahan belum di-commit: berhenti dan lapor. Migrasi sementara milik cabang: 0321-0322; tambahan bila perlu 0332.

Keputusan CTO: betulkan ketiganya sesuai usulan. Prinsip: tamu tidak boleh dirugikan (uang tertahan), outlet tidak boleh membayar lebih (cap tetap).
1. facility-breakfast-money.ts:193 + payment-refund.service.ts:535: klasifikasi refund mengenali prefix `facility-breakfast-refund:late:` sehingga refund late tidak gagal cap_exceeded saat ada refund admin pending. Uji approval sebenarnya (bayar 100.000, admin pending 10.000, facility 100.000).
2. facility-breakfast-money.ts:194: pembatalan saat refund admin pending lalu refund itu ditolak/kedaluwarsa -> ajukan ulang sisa kewajiban dengan key turunan failed-refund, intent lock dan cap yang sama. Test: total refund tidak pernah melebihi bayar.
3. facility-breakfast-consumers.ts:163: event payment.funds_unallocated milik sarapan (callback Duitku BILL_CLOSED setelah batal) -> satu refund penuh idempoten per fund/evidence. Test alur: batal -> uang telat -> tepat satu refund.
Bukti: test gagal-dulu per butir, test terarah sarapan + payment-refund lewat `heavy`, tsc, eslint/prettier, db:generate kosong. Subagent architect effort xhigh atas delta. Commit, push ws/breakfast-pay (tanpa --force).
Tunggu job dan subagent tanpa polling berkas (notifikasi datang sendiri). Satu laporan akhir: commit, bukti, temuan architect, angka subagent.
