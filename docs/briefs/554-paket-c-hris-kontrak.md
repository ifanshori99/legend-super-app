# 554 Paket C: kontrak dan transport HRIS (3 kartu)
Peran: engineer (~/.agents/team/roles/engineer.md). Kartu: legend-zygi, legend-bf20, legend-je1f. Baca `bd show` tiap kartu dan paket C di docs/briefs/552-triage-result.md.
Basis: origin/ws/hris-misc (belum masuk m1; bind/transport sudah ada, jangan tulis ulang). `git worktree add .worktrees/hris-contract -b ws/hris-contract origin/ws/hris-misc`. Migrasi 0389-0391.
Tingkat K (akses, data pribadi: selfie, binding supervisor). Boleh ubah `core-storage.routes.ts` dan `core-storage-access.ts` bila scanner reject butuh. Test: tenant/outlet lain ditolak, karyawan tidak bisa bind/unggah untuk orang lain, serverTime QR tidak bisa dipalsukan klien.
Jangan sentuh payroll-*, service cuti/payroll, layar/rute hris-requests, UI 539, operations-*, akuntansi, CRM, edge.
Paralel: Explore, test-writer, 1 implementer per kartu, reviewer akhir. Test gagal-dulu, test terarah lewat `heavy`, tsc api/shared, eslint/prettier, `db:generate` kosong. Commit per kartu, jangan merge. Lapor dengan angka subagent dan yang belum diuji.
