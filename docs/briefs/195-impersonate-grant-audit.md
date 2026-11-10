# Brief: engineer — impersonate hanya dengan grant, durasi, dan audit atas nama impersonator (legend-rzirp, legend-6yfhc)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/impersonate-grant` dari `ws/support-readonly` da19ac16 (legend-cg071, antre merge train). Worktree `.worktrees/impersonate-grant`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Saat support-readonly masuk m1, rebase ke m1 sebelum lapor bila sempat.

## Tujuan
Tingkat K (auth). Lanjutan legend-cg071, yang sudah membuat sesi impersonated tanpa grant tidak bisa membaca atau menulis data tenant.
- `legend-rzirp`: gate `/admin/impersonate-user` di Better Auth (`hooks.before` di `lib/auth.ts`): pemanggil platform admin, target bukan platform admin, pemanggil punya grant support aktif di tenant tempat target punya peran; `impersonationSessionDuration` <= 60 menit; baris audit tenant (TEN-04) saat impersonate dimulai dan berakhir.
- `legend-6yfhc`: tulisan selama grant `read_write` tercatat atas nama impersonator (dengan user tenant sebagai konteks), bukan hanya user tenant. Pakai satu titik di konteks request/audit, bukan per service.
Detail: `bd show legend-rzirp`, `bd show legend-6yfhc`, `bd show legend-cg071` (keputusan MFA opsi (a): tidak ada bypass MFA).

## Kartu
`legend-rzirp`, `legend-6yfhc`. Untuk tiap kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `lib/auth.ts`, middleware auth/support-session, `lib/request-context.ts` dan penulis audit, layanan grant support, test. Jangan: skema/migrasi kecuali kolom audit wajib (nomor sesudah yang ada di m1 dan antrean: 0153 dan 0154 sudah dipesan, pakai 0155 dengan when 1794234000000; catat). Jangan sentuh refund, pos-day, pos-shift, edge, `receipt_sequences`, payroll, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: impersonate tanpa grant ditolak; impersonate platform admin ditolak; grant kedaluwarsa ditolak; durasi sesi dibatasi 60 menit; baris audit tenant tercatat saat mulai dan berhenti; tulisan di grant read_write tercatat atas nama impersonator; lintas tenant tidak bocor. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/195b-second-opinion-impersonate-grant.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
