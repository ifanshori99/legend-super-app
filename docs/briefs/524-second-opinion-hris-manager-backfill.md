# 524 Second-opinion Codex: backfill atasan + ubah atasan HRIS (ws/hris-manager-backfill)

Peran: second-opinion (~/.agents/team/roles/second-opinion.md). READ-ONLY, jangan commit. Repo: /Users/ifanshori99/Projects/legend super app/legend. Diff: `git diff origin/ws/hris-leave-guard...origin/ws/hris-manager-backfill` (abaikan snapshot drizzle JSON, screenshot, review page HTML).
Kartu: legend-qhqf8 (skrip backfill employees.manager_id), legend-f4uvg (PATCH /api/hris/employees/:id/manager + tombol 'Ubah atasan').
Fokus (akses, tingkat K): siapa boleh mengubah atasan (izin, tenant, outlet scope, ubah atasan diri sendiri harus 403), siklus atasan (A atasan B atasan A), atasan beda tenant atau karyawan nonaktif, skrip backfill (default dry-run, --apply wajib --ids, tidak menimpa data yang sudah diisi manual, idempotent), audit log, UI menyembunyikan tombol sesuai API (canChangeEmployeeManager). Konteks founder Q56: scope bawahan langsung baru dinyalakan setelah daftar manual atasan kosong.
Laporan: temuan P0-P3 dengan file:baris, skenario gagal konkret, usulan fix. Tanpa temuan: tulis jelas. Satu laporan akhir.
