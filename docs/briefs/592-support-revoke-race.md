# Brief: engineer (Claude Sonnet) — tutup celah cabut akses dukungan saat request berjalan (legend-hqjde)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Tingkat K (akses). Kartu: `bd show legend-hqjde` (skenario dan kriteria test dari second opinion).

## Masalah
`apps/api/src/middleware/support-session.ts:170`: grant akses dukungan diperiksa sebelum body dibaca. PATCH bisa menahan body, Owner mencabut (200), lalu body dilanjutkan dan mutasi tetap jalan.

## Arah keputusan CTO
Pemeriksaan grant harus terjadi di dalam transaksi mutasi yang sama, dengan kunci baris grant (mis. `FOR SHARE` di mutasi, `FOR UPDATE` di pencabutan), sehingga setelah revoke 200 tidak ada mutasi dukungan yang commit. Pakai satu helper bersama untuk semua route yang menerima sesi dukungan; jangan tambal per route.
Tambahan: `apps/api/drizzle/0287_support_access_grant_tenants.sql:21` (di batch53 jadi 0309) mensyaratkan pemilik fungsi SUPERUSER/BYPASSRLS. Periksa `deploy/single-vm/` + `docs/deployment.md`: pastikan role migrasi produksi memenuhi syarat itu dan terdokumentasi di checklist; bila tidak, laporkan, jangan ubah migrasi.

## Repo
Worktree basis `int/batch53` (sudah berisi ws/dheu-m1 + fix/batch53-blockers). Cabang `fix/support-revoke-race`. Migrasi baru tidak diharapkan; bila perlu, pakai 0422 saja.

## Bukti selesai
- Test gagal-dulu: request ditahan → revoke 200 → body dilanjutkan → mutasi ditolak dan data tidak berubah; audit tetap satu entri; lintas tenant.
- `LEGEND_TEST_FILES=... heavy pnpm test` hijau, pra-gate AGENTS.md hijau, satu subagent architect effort xhigh.
- Commit + push tanpa --force. Jangan merge. Lapor SHA, angka subagent.
