# 1159 Bundel web/test hygiene (tingkat S)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per kartu, satu implementer per kartu, berkas terpisah).
Cabang dari `origin/milestone/m1` (worktree dari Ghostex). Push tanpa `--force`. Tanpa migrasi. `bd show <id>` dulu, klaim, tutup bila selesai.
Kartu:
1. `legend-uwafm` (P2): flake `payroll-payout-911-closure-swap` timeout 20 detik saat full run paralel. Cari akar (lock/barrier/fixture bersama); perbaiki test/setup saja. JANGAN ubah logika payout; menaikkan timeout hanya bila terbukti lambat wajar, bukan menutupi hang.
2. `legend-hmig6` (P2): buktikan server menolak tulis di sesi support read-only (test API untuk beberapa route tulis). Bila ada route yang menerima tulis: BERHENTI di kartu ini dan lapor route-nya (perbaikan akses = tingkat K, keputusan CTO). Sisa UI: cek banner tidak menumpuk.
3. `legend-n64n` (P3): data contoh "Nasi Goreng Kampung" keluar dari bundel klien (`apps/web/src/components/design-system/sample-data.ts:31`, `design-system/v2/sample.ts`, mock reservasi ws08).
Teks UI baru ke katalog (`node --test tests/text-contract.test.mjs`).
Bukti: test gagal-dulu/reproduksi per kartu. Test terarah lewat `heavy` (satu run gabungan). Prettier, eslint. Typecheck API + web sekali lewat `heavy` (WAJIB). `reviewer` sonnet sekali. Jangan kirim laporan sela.
Laporan: head SHA + nama cabang, kartu selesai/dilewati, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
