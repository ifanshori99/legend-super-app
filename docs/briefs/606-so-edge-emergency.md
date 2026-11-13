# Brief: second-opinion — area akses + migrasi + sinkron offline: tombol darurat edge

Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (maks 3). Tidak mengubah file.

Repo: `/Users/ifanshori99/Projects/legend super app/legend` (read-only; `git fetch origin` dulu).

## Rentang diff
`git diff origin/milestone/m1...origin/ws/edge-emergency-impl -- apps/api/src packages/shared/src apps/api/drizzle` (migrasi 0400-0402).

Berkas berisiko: `services/panic-*.ts`, `routes/emergency-*.ts`, outbox/sync edge<->cloud untuk `panic_alert.*`, `EDGE_API_EXACT_ROUTES`, `server.ts` (WebSocket), izin `facility.emergency.*`, migrasi 0400-0402.

## Invariant
- Q94: alarm tanpa jawaban 15 detik tampil di semua layar POS outlet (nama ruangan + jam saja, tanpa data pribadi).
- Q95: penerima = facility attendant, supervisor, outlet manager, GM yang on duty (owner diperlakukan sama dengan manajer: on duty); tutup insiden hanya pemegang `facility.emergency.resolve` di cloud.
- Sesi penerima butuh device terdaftar + PIN staf + on duty; tidak bisa lintas outlet/tenant.
- Event sinkron idempoten; resolve cloud menutup alert di edge; tidak ada alert hilang atau terduplikasi.
- Cloud menolak aksi untuk outlet yang punya edge node aktif (409).
- RLS dan migrasi aman untuk data yang ada.

## Laporan
Format peran: satu baris per temuan.
