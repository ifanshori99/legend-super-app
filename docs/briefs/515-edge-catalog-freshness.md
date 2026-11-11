# 515 Kesegaran katalog edge + kebijakan jual saat basi (legend-10nex P1, harga, tingkat K)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend. AGENTS.md proyek berlaku.
Langkah 0: `git -C "/Users/ifanshori99/Projects/legend super app/legend" fetch origin ws/edge-catalog-followups && git -C "/Users/ifanshori99/Projects/legend super app/legend" worktree add .worktrees/edge-catalog-fresh -b ws/edge-catalog-fresh origin/ws/edge-catalog-followups`. PORT dan nama DB sendiri. Migrasi sementara hanya 0326-0327.

Temuan Codex: master-sync.ts:590 kegagalan stream katalog hanya dilog; kasir bisa jual harga lama atau produk nonaktif tanpa batas.
Keputusan founder Q57: status kesegaran per stream kritis (katalog, harga, ketersediaan). Gagal sinkron: peringatan di layar kasir + alarm owner segera. Lewat 24 jam tanpa sinkron sukses: penjualan ditahan sampai owner mengizinkan (override tercatat siapa, kapan, sampai kapan). Berlaku juga saat offline.
Bukti (jangan sampai rugi): test gagal-dulu bahwa setelah 24 jam basi transaksi ditolak tanpa override, override tercatat dan kedaluwarsa, sinkron sukses mereset status, test offline dan jam perangkat mundur tidak bisa menghindari batas. UI peringatan kasir pakai komponen yang ada (ikut review UI founder).
Paralel: Explore (edge sync, POS jual, alarm owner), test-writer, implementer per bagian, lalu subagent architect effort xhigh atas seluruh diff.
Gate: tsc, eslint/prettier, test terarah lewat `heavy`, db:generate kosong. Commit, push (tanpa --force). bd: 10nex.
Tunggu job latar dengan Monitor di giliran yang sama. Satu laporan akhir: commit, migrasi, temuan architect, angka subagent, yang belum terbukti.
