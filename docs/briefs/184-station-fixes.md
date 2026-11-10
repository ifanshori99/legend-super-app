# Brief: engineer — perbaikan station printer (Codex 159) dan gate station (Codex 152)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/station-fixes` dari ujung `milestone/m1` terbaru (bddf8442 atau lebih baru), worktree `.worktrees/station-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan (paralel lewat subagent, file tidak bertumpuk)
1. `legend-4xai` (P2, release-blocker): dua temuan Medium di `docs/briefs/159-second-opinion-station-printer.result.md`: binding printer yang dicabut tetap berlaku; form basi menimpa binding baru (pakai versi/`updated_at` optimistik, 409 bila basi).
2. `legend-cy2e` (P2, auth = tingkat K): `apps/api/src/middleware/permissions.ts:220`: grant outlet A + station B menghasilkan context A saja karena station reach hanya dihitung bila outlet reach kosong. Gabungkan kedua reach di gate station, pertahankan filter station di service. Sumber: `docs/briefs/152-second-opinion-station-scope.result.md`.
Path baris di file hasil merujuk cabang lama; cari ulang di m1.

## Kartu
`ghostex board associate` keduanya, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: modul station/printer binding (service, route, web form terkait), `apps/api/src/middleware/permissions.ts` (gate station), test. Jangan: `pos-shift.service.ts`, modul refund, auto-journal, payroll, open bill, edge PIN, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu: binding dicabut tidak dipakai lagi; simpan form basi 409; grant outlet A + station B melihat ticket station B dan tidak melihat station lain di outlet B. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob dengan jumlah file jalan; test root lewat `pnpm test` (suite PostgreSQL butuh DB terisolasi). tsc lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/184b-second-opinion-station-fixes.md` di folder utama (tidak di-commit).

## Laporan
Sekali setelah keduanya selesai: hasil, bukti, file berubah, SHA, migrasi (bila ada: nomor + `when` di atas 1794220939622), risiko tersisa. Jangan menunggu proses global (`pgrep vitest` milik agent lain). Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
