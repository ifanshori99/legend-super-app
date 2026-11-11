# 509 Codex engineer: bundel infra/QA (sementara, izin founder Q55)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend. Kamu Codex: jangan jalankan `bd` (CTO memindah kartu).
Langkah 0: `git -C "/Users/ifanshori99/Projects/legend super app/legend" fetch origin milestone/m1 && git -C "/Users/ifanshori99/Projects/legend super app/legend" worktree add .worktrees/infra-qa -b ws/infra-qa origin/milestone/m1`. Kerja hanya di worktree itu, PORT dan nama DB sendiri. Tanpa migrasi.

Kartu (file terpisah, satu subagent per kartu, paralel):
1. legend-3het: mock runtime (lib/mock/runtime) memetakan AccountingError ke kode aslinya, bukan INTERNAL_ERROR. Pilih: AccountingError extend CoreError, atau mapper domain-error terdaftar di runtime; hapus wrapper per fitur di features/ws07-accounting/mock.ts register(). Logika uang tidak berubah.
2. legend-cuyu: test root yang memindai packages/shared/src/**/fixtures* dan menolak timestamp ISO literal di masa depan pada field expiresAt/claimableUntil/validUntil/deadline; fixture wajib dari jam fixture. Betulkan fixture yang melanggar.
3. legend-7305j: apps/api test accounting-journal-expiry-race dan accounting-journal-manual-settle bentrok saat paralel (tenant dan policy approval sama). Beri tenant/policy fixture sendiri per file. Bukti: kedua file lulus dijalankan bersamaan.

Bukti selesai: test gagal-dulu per kartu (bila relevan), test terarah lewat `heavy`, tsc paket yang disentuh, eslint/prettier file berubah. Commit per kartu, push `ws/infra-qa` (tanpa --force).
Laporan: commit per kartu, hasil gate, angka subagent (total, puncak, pemegang heavy), yang belum terbukti.
