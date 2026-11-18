# 1130 Bundel P2: codec pajak outlet, batal sarapan cek penyedia, rekap struk belum sinkron (tingkat K)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Ikuti `docs/briefs/_TEMPLATE-workstream.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (3 Explore, test-writer, implementer per kartu; berkas terpisah).
Cabang `ws/1130-p2-pajak-sarapan-rekap` dari `origin/milestone/m1` (worktree sudah dibuat oleh Ghostex). Push tanpa `--force`. Tanpa migrasi (butuh migrasi: berhenti dan lapor dulu).

Kartu (`bd show <id>`, klaim dengan `bd update <id> --claim`):
1. `legend-srfud`: `packages/shared/src/platform/config-codecs.ts:350-375` mengasumsikan tenant-wide dan unlocked. Saat API memanggil codec, isi pemilik outlet aturan pajak dan point-value lock yang asli. Cari dulu pemanggil API-nya; bila belum ada wiring API, buat pengaman (tolak/isi eksplisit) plus test, lalu lapor.
2. `legend-9sw2w`: `apps/api/src/services/facility-breakfast-consumers.ts:340` (`fireBreakfastOrderTx`) membatalkan lokal di dalam lock tanpa cek penyedia. Pindahkan cek penyedia ke luar lock, atau buktikan dengan test bahwa tidak ada refund ganda dan outlet tidak rugi. Aturan uang founder: bila ragu, pilih yang membatasi pembayaran.
3. `legend-21c8n`: rekap hari kasir menampilkan hitungan "struk belum sinkron" (edge->cloud receipt run, `receipt_run.reported`). Cek dulu applier receipt run (legend-ol6v) ada di m1; bila belum, lewati kartu ini dan lapor. Teks UI baru: daftarkan ke katalog (`tests/text-contract.test.mjs`).

Jangan sentuh: berkas refund/DP/payment-webhook (ws/1072, ws/1126), area-frame (ws/1094/1120), edge gate (ws/1122).
Bukti: test gagal-dulu per kartu (merah di base, hijau di head); test terarah lewat `heavy`; prettier, eslint; typecheck API (dan web bila shared/web berubah) sekali lewat `heavy`; `db:generate` kosong. Review: `architect` xhigh untuk 9sw2w (uang), `reviewer` untuk sisanya, satu giliran.
Laporan: head SHA, kartu selesai/dilewati, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
