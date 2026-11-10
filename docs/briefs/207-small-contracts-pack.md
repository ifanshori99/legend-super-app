# Brief: engineer — paket kontrak kecil: versi order POS, izin notifikasi, payload event daily-ops (legend-63l6, legend-kz1m, legend-lvx2)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/small-contracts-pack` dari ujung `milestone/m1` terbaru, worktree `.worktrees/small-contracts-pack`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Tiga kartu kecil yang sudah ditriage (komentar CTO 9 Nov di tiap kartu berisi bukti dan sisa kerja; verifikasi ulang dulu):
- `legend-63l6` (P2): POS order optimistic concurrency. Tambah versi order (atau updatedAt) ke kontrak POS + `expectedVersion` di endpoint yang mengubah order; tulisan basi dari perangkat kedua ditolak `PRECONDITION_FAILED`. Bila kolom baru wajib: migrasi `0159` dengan when `1794238000000` (0155-0158 sudah dipesan; catat).
- `legend-kz1m` (P2, tingkat K: izin): kode izin admin notifikasi (mis. `org.notification_policy.manage`) di katalog akses `packages/shared/src/permissions.ts` dan template peran yang wajar (owner, admin tenant), tanpa memasang ke route yang belum ada.
- `legend-lvx2` (P2): payload schema `defineDomainEvent` untuk `checklist.completed`, `checklist.reminded`, `equipment_service.reminded`, `prep_list.created` di `packages/shared/src/operations/events.ts` + test.
Detail: `bd show <id>` untuk ketiganya.

## Kartu
Untuk tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: kontrak dan layanan order POS, katalog izin dan template peran, skema event operasional, test. Jangan: refund, pos-day, pos-shift, edge, `receipt_sequences`, payroll, auth Better Auth, `worker-main.ts`, UI.

## Bukti selesai
Test reproduksi gagal dulu: dua perangkat mengubah order yang sama pada status sama, yang kedua ditolak `PRECONDITION_FAILED`; klien lama tanpa `expectedVersion` tetap jalan (jelaskan keputusanmu); izin baru ada di katalog dan peran owner; payload event tervalidasi dan payload salah ditolak. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review: reviewer Opus + architect paralel (izin dan konkurensi). Brief Codex `docs/briefs/207b-second-opinion-small-contracts-pack.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil per kartu, bukti, file berubah, SHA, migrasi, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
