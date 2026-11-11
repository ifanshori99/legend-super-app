# Brief: perbaikan temuan Codex — payroll + ekspor PBJT (6pha/in4m)

Peran: engineer (`~/.agents/team/roles/engineer.md`). Cabang `ws/6pha-payroll-tax-bundle` (397bb1c5); buat worktree `.worktrees/6pha` lagi. Keputusan CTO: semua nyata. Migrasi: ubah 0288 sementara (belum di-merge).

1. P2 `drizzle/0288_tax_report_exports.sql:37`: hanya tenant RLS. Pasang `app.enforce_outlet_rls` (ikuti pola tabel per-outlet lain); konflik idempotensi lintas outlet jangan bocorkan keberadaan kunci (jawab seperti kunci baru di scope sendiri, atau 404). Test role `legend_app` scope outlet A tidak bisa baca B.
2. P2 `tax-pbjt-export.service.ts:177`: commit tidak pasti -> CSV milik baris permanen terhapus. Keputusan: hapus file hanya setelah memastikan baris TIDAK ada (query ulang berdasarkan kunci idempotensi); bila ragu, biarkan file (yatim lebih aman dari baris tanpa file). Test: commit sukses + koneksi putus -> retry dapat URL file yang ada.
3. P2 `apps/web/src/features/ws10-payroll-run/mock.ts:278`: tambah identitas mock ketiga; test alur buat -> HR approve -> final approve -> lock dengan 3 orang berbeda.
4. P2 `packages/shared/src/tax/pbjt-export-csv.ts:35`: total `transactions` hitung transaksi unik di tingkat rekap (bukan per grup aturan). Test transaksi di dua grup.
5. P2 `apps/api/src/db/schema/accounting-tax.ts:206`: buat snapshot drizzle untuk 0288 sehingga `db:generate` berikutnya kosong (ikuti cara 6c6 membuat 0285_snapshot.json).
6. P2 `_journal.json:1660`: `when` 1794331000000 sama dengan 0278 dan 0285 di cabang lain. Beri nilai unik lebih tinggi (mis. 1794331000288) dan tulis di laporan; merge train menata urutan akhir.
7. Saran: CHECK database `approved_by_hr <> created_by` dan `approved_by_finance <> created_by` sudah di kartu legend-7ui6v; jangan kerjakan di sini.

Paralel: test-writer gagal-dulu 1-4, implementer per file, lalu reviewer (architect xhigh bila mengubah RLS/migrasi). Bukti: test gagal-dulu, 8 berkas terarah hijau, `db:generate` kosong, eslint+prettier, typecheck api+web heap 6144, commit+push. Laporan: commit, angka test, angka subagent.
