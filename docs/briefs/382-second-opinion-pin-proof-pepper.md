# Brief: second-opinion — bukti PIN absen layar outlet dan pepper PIN per outlet

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree baca: `git worktree add --detach .worktrees/so-382 469673f2` (ws/jmsdx-pepper, sudah berisi u7g9w), hapus setelah selesai.
Rentang: `git diff d07b6cf8 469673f2 -- <berkas>` (~1700 baris). Runbook: `docs/runbooks/edge-node-stolen.md`.

## Berkas
- `apps/api/src/services/staff-pin-proof.service.ts`, `apps/api/src/db/schema/staff-pin-proof.ts`, `apps/api/drizzle/0241_staff_pin_proofs.sql`, `staff-pin-proof.custom.sql`
- `apps/api/src/services/device-pin.service.ts`, `apps/api/src/routes/device-pin.routes.ts`
- `apps/api/src/services/device-pin-pepper.ts`, `apps/api/src/edge/staff-pin-pepper-registry.ts`, `apps/api/src/edge/staff-pin-pepper-store.ts`, `apps/api/drizzle/0225_edge_staff_pin_peppers.sql`
- `apps/api/src/services/staff-pin-sync.ts`, `apps/api/src/edge/staff-pin-pull.ts`, `staff-pin-resend.ts`, `apps/api/src/routes/staff-pin-sync.routes.ts`
- `apps/api/src/edge/runtime.ts`, `apps/api/src/services/core-storage-runtime.ts`
- (jejak) rute `POST /api/hris/attendance/outlet-clock` di `hris-attendance.routes.ts`

## Invariant
- Bukti PIN sekali pakai, 120 detik, terikat staf + device + outlet + selfie; replay atau dipakai di outlet/device lain ditolak; replay outbox edge->cloud tidak membuka celah.
- Brute force PIN dibatasi per device dan per staf, tahan permintaan paralel; lockout tidak bisa direset oleh sinkron/rehash.
- Edge tidak pernah menerima pepper v1 atau pepper outlet lain; pepper tidak tercatat di log/respons; node dicuri hanya membuka PIN outletnya, dan runbook mencabut semuanya.
- Rehash v1->v2 di cloud aman terhadap balapan dengan reset PIN.
- Isolasi tenant/outlet dan RLS di tabel baru.

## Effort
high (auth, bukan uang).

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
