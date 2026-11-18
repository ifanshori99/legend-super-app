# 1137 Layar AI tindak lanjut audit + waktu pasca-lock platform-approval (S + K uang kecil)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore + implementer per kartu, test-writer; berkas terpisah).
Cabang `ws/1137-ai-layar-approval-waktu` dari `origin/milestone/m1` (worktree dari Ghostex). Push tanpa `--force`. Tanpa migrasi.

1. `legend-b2kq3` (S web, tanpa layar baru): keputusan CTO di kartu. 'Cabut' dan 'Batalkan' tetap aktif saat kunci platform; penjelasan saat login tertunda berhenti polling karena kunci; satu tombol utama per layar; badge 'Belum terhubung' vs 'Dikunci platform' selaras saat `?ai=off`; token type-eyebrow; hydration warning div di dalam p (`PayrollConfigScreen`). Berkas: `apps/web/src/features/ws12-ai-settings/`, `ws12-ai-admin/`. Teks baru ke katalog (`tests/text-contract.test.mjs`). `ui-auditor` sekali.
2. `legend-ijy8u` (K uang): `apps/api/src/services/platform-approval.service.ts` mengambil `now` sebelum lock untuk cek peran dan tenggat chain (juga `createdAt` level berikutnya). Ambil waktu sesudah lock (atau dari DB `now()` di transaksi yang sama). Gagal-aman: bila ragu, tolak. Test: approval tepat di batas tenggat yang menunggu lock.

Bukti: test gagal-dulu per kartu. Test terarah lewat `heavy`. Prettier, eslint. Typecheck API dan web sekali lewat `heavy`. `architect` xhigh untuk ijy8u, `reviewer` + `ui-auditor` untuk b2kq3, satu giliran.
Laporan: head SHA, kartu selesai, risiko, screenshot 390/1280 layar AI. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
