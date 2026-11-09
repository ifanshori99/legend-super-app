# Lanjutan brief 280 (G2ll9): tes migrasi 0187 sebagai pemilik non-superuser

Cabang `ws/audit-retention-purge` (6bab7deb), worktree milikmu. Jangan push, jangan merge.

1. Merge `milestone/m1` (d2080951) ke cabangmu. Rantai ulang 0187: `prevId` snapshot ke 0186 di m1, idx, `when` harus > 1794265000000 (0186). Migrator Drizzle melewati migrasi ber-`when` lebih kecil dari yang terakhir diterapkan.
2. Tes migrasi 0187 dan fungsi SECURITY DEFINER dengan migrator sebagai pemilik tabel non-superuser. Ikuti pola 0186 dan perbaikan 0178 di m1 (NO FORCE RLS sementara untuk blok DO; migrator non-superuser kena 42501). Tes harus gagal dulu bila perilakunya belum benar.
3. Temuan architect no. 3: audit provisioning menandai fungsi SECURITY DEFINER di skema `app` yang lupa `REVOKE ... FROM PUBLIC`.
4. Buat bead lanjutan untuk purge audit di database edge.

Bukti: `LEGEND_TEST_FILES` terarah, `tsc` api lewat `heavy`, eslint + prettier, satu `architect` untuk diff baru (tingkat K).
Lapor sekali: SHA baru, `when` dan prevId 0187, bukti, risiko.
