# 500 Akses dokumen pemegang saham + penjaga ledger (WS-E, backend)

Peran: engineer (`~/.agents/team/roles/engineer.md`). Worktree sendiri dari `origin/ws/ledger-integrity` (e916b037), cabang `ws/ledger-guards`. Tingkat K (akses + uang + migrasi): architect effort xhigh sekali di akhir.

Langkah 0 (prioritas, sebelum kartu): perbaiki 7 temuan di `docs/briefs/497-findings-fixes.md` (keputusan CTO sudah tertulis). Migrasi untuk temuan: lanjutkan nomor sementara dari cabang dasar.

Kartu (selesaikan semua, lalu lapor):
- legend-lt0v4 (P1): akses dokumen pemegang saham hanya dari versi alokasi approved terkini (`profit-share-membership.ts:42-43`); pemegang saham yang dikeluarkan di versi berikut kehilangan akses. Plus: `fiscal_periods.status` hanya boleh berubah lewat transisi sah dengan kenaikan versi (tolak UPDATE langsung oleh `legend_app`).
- legend-k048r: tolak pembalikan manual jurnal yang direferensikan `fixed_asset_depreciations` atau `fixed_asset_depreciation_reversals` (service + trigger).
Keduanya menyentuh migrasi; kerjakan berurutan bila berkas bertumpuk.

Migrasi: nomor sementara 0312-0316 (lanjut dari 0310/0311 di cabang dasar), `when` unik naik.

Paralel: Explore 1, test-writer gagal-dulu tiap kartu, implementer per kartu. Test terarah lewat `heavy`. Gate lint: `pnpm exec eslint` + `prettier --check` berkas berubah, tanpa array zsh. Langkah 1: `bd show` + `git log --all --oneline | grep <id>` cek basi. Push cabang. Laporan: commit, test, temuan architect, angka subagent.
