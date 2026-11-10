# Brief: engineer — kunci endpoint admin Better Auth dan push dari sesi support (legend-imdzn, legend-8bvin)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/better-auth-admin-lockdown` dari `integ/m1-batch31` (d7a95d0c). Worktree `.worktrees/better-auth-admin-lockdown`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Dua temuan review ganda (tingkat K auth). Detail dan skenario: `docs/briefs/193b-second-opinion-support-readonly.result-architect.md` dan `.result-architect2.md`.
- `legend-imdzn` (P1): role `admin` Better Auth memegang seluruh `adminAc` (`packages/shared/src/permissions.ts:41-42`); hook `apps/api/src/lib/auth.ts:84` hanya menjaga `/admin/impersonate-user`; guard `apps/api/src/middleware/support-session.ts:181-195` hanya menolak sesi impersonate. Sesi admin biasa (bahkan yang sudah dicabut dari `platform_admins`) bisa `list-users` lintas tenant, `set-user-password` Owner tenant, lalu masuk sebagai Owner tanpa grant, persetujuan, atau audit.
  Perbaikan: di `hooks.before`, tolak semua `/admin/*` kecuali yang memang dipakai produk (cek pemakaian nyata di `apps/web` dan `apps/api`; kandidat: `impersonate-user`, `stop-impersonating`, `has-permission`). Endpoint yang tetap dibuka wajib cek registry `platform_admins` aktif, bukan hanya `user.role`. Persempit statement role admin di `permissions.ts` sesuai yang dibuka.
- `legend-8bvin` (P2): daftar rute kredensial yang diblok di `support-session.ts:49-62` belum memuat `POST /api/notifications/push-subscriptions`; langganan push tersimpan per user (`db/schema/notification.ts:182`) dan tetap mengirim notifikasi Owner ke browser admin sesudah grant habis. Tambahkan polanya.

## Kartu
`legend-imdzn`, `legend-8bvin`. Di awal: `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Scope
Boleh: `apps/api/src/lib/auth.ts`, `apps/api/src/middleware/support-session.ts`, `packages/shared/src/permissions.ts`, test. Jangan: penunjukan Owner platform (`platform-tenant-owner.service.ts`, cabang lain), `access.service.ts` (`endRoleAssignment` dikerjakan thread lain), refund, PIN edge, pajak, UI, migrasi.

## Bukti selesai
- Reproduksi dulu: test yang gagal di basis untuk tiap skenario (`list-users`, `set-user-password`, `set-role`, `update-user`, `remove-user` dari sesi admin biasa dan dari admin yang dicabut dari `platform_admins`; push-subscription dari sesi support read_write menjawab 403 `SUPPORT_ACCESS_READ_ONLY`), lalu lulus.
- Test lama tetap lulus: support-session-readonly, platform-support-access, platform-access-api, platform-admin-provision, identity/MFA, access-hardening. `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...`) lewat `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`, sebut jumlah file.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier untuk berkas berubah. Jangan jalankan `pnpm check` penuh.
- Review K: subagent reviewer Opus + architect paralel; temuan nyata dibetulkan.
- Tulis brief Codex `docs/briefs/232b-second-opinion-better-auth-admin.md` di folder utama (tidak di-commit): rentang diff, berkas berisiko, invariant. Jangan sertakan temuan Claude.

## Laporan
Sekali: hasil per kartu, endpoint admin yang tetap dibuka dan alasannya, bukti (perintah dan hasil), file berubah, SHA, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
