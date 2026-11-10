# Brief: engineer — akses support read_write menunggu persetujuan owner tenant (legend-c9kbk)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/support-rw-owner-approval` dari `ws/impersonate-expiry-cap` a0f0c127 (legend-npkpz, antre merge train). Worktree `.worktrees/support-rw-owner-approval`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-c9kbk` (P1, tingkat K: auth dan data pribadi). Keputusan founder Q37: grant support `read_write` harus disetujui owner tenant dulu. Hari ini `packages/shared/src/platform/support-access.ts` mengizinkan read_write cukup dengan MFA, grant dibuat super admin platform. Keputusan founder lain yang tetap berlaku: durasi 15/30/60/120 menit, default 60 (Q38).
Keputusan CTO:
- Grant read_write dibuat berstatus menunggu persetujuan. Selama menunggu, perlakuannya sama dengan tidak ada grant (guard, impersonate, `impersonationSessionEnd` dari npkpz).
- Hanya owner tenant itu yang bisa menyetujui atau menolak. Sesi owner wajib sudah lolos 2FA, sama seperti write-off nomor struk (legend-0hzqw). Super admin platform tidak bisa menyetujui grant buatannya sendiri.
- Durasi akses dihitung sejak disetujui, bukan sejak diminta. Permintaan yang tidak dijawab dalam 24 jam kedaluwarsa sendiri.
- Setuju, tolak, dan kedaluwarsa masing-masing menulis audit tenant (TEN-04) dengan label Indonesia di katalog yang sama dengan npkpz.
- Owner diberi tahu lewat jalur notifikasi yang sudah dipakai grant read_only.
- read_only tidak berubah.
- Endpoint API owner-only (permission di `packages/shared/src/permissions.ts`, `requirePermission`/`requireOutletPermission` sesuai pola, `requireTrustedOrigin`, `jsonBody`, skema zod strict).
- Tidak ada UI di cabang ini: buat kartu UI terpisah untuk layar persetujuan owner (menunggu review UI founder). Perbarui PRD bagian F4 sesuai keputusan di atas.
Detail: `bd show legend-c9kbk`, `bd show legend-d22m`, `bd show legend-npkpz`.

## Kartu
`ghostex board associate legend-c9kbk`, `bd update legend-c9kbk --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: skema/service grant support, `support-access.ts` di shared, guard impersonate dan grant, endpoint owner baru, permissions, validator shared, label audit, sweep kedaluwarsa bila memang perlu (catat; `worker-main.ts` hanya untuk mendaftarkan sweep ini), PRD F4, test. Migrasi: nomor `0160`, when `1794239000000` (dipesan untuk cabang ini; 0157-0159 dipakai cabang lain). Jangan: Better Auth core/MFA selain membaca status 2FA, refund, payroll, pos, edge, UI.

## Bukti selesai
Test reproduksi gagal dulu di basis: grant read_write langsung bisa dipakai tanpa persetujuan owner. Sesudah perbaikan: grant menunggu ditolak guard dan impersonate; owner setuju, akses jalan selama durasi sejak setuju; owner tolak, akses tidak pernah jalan; tidak dijawab 24 jam, kedaluwarsa; non-owner 403; owner tanpa 2FA 403; super admin tidak bisa menyetujui sendiri; owner tenant lain tidak bisa menyetujui; read_only tetap seperti sebelumnya; audit tercatat untuk tiap transisi. `db:generate` kosong sesudah migrasi. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/211b-second-opinion-support-rw-owner-approval.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi dan langkah rilis, kartu UI yang dibuat, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
