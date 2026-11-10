# Brief: engineer — outlets di /api/me/access, lalu konteks outlet staf (ebt9f + 2aqp)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit; jangan baca TEAM.md utuh), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Buat worktree baru `.worktrees/ebt9f-me-outlets`, cabang `ws/ebt9f-me-outlets`, dari `ws/ws01-staff-access` (6f300150: m1 + oldg, sudah direview, belum masuk m1). Lalu `pnpm worktree:setup` (PORT dan DB sendiri).

## Tujuan
1. legend-ebt9f (P1): tambah `outlets` (id, nama, timeZone, businessDayCutoff; HANYA outlet yang ditugaskan ke pemanggil) ke `myAccessViewSchema` (packages/shared) dan respons `GET /api/me/access`. Filter di SQL dari user sesi, bukan dari input.
2. Sesudah commit ebt9f: legend-2aqp (P2): konteks outlet staf untuk layar operasional. Board saat ini memanggil `/api/example/outlets`; ganti ke outlets dari `/api/me/access`, pemilih outlet di `apps/web/src/components/layout/area-frame.tsx`, dipakai `features/ws03-floor`. Ikuti `~/.agents/team/ui-standard.md`. Satu outlet: tanpa pemilih. Nol outlet: keadaan kosong yang jelas.

## Kartu
`legend-ebt9f`, lalu `legend-2aqp`. Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- `bd show legend-ebt9f`, `bd show legend-2aqp`.
- Pola kontrak: AGENTS.md "Adding a resource end to end", `docs/backend.md`, `docs/frontend.md`.

## Scope
- Boleh diubah: `packages/shared` (validator dan tipe me/access), route dan service me/access di `apps/api`, test terkait, `apps/web/src/lib/areas/*`, `area-frame.tsx`, `features/ws03-floor`, docs kontrak.
- Jangan disentuh: migrasi (kartu ini tidak butuh migrasi; bila ternyata butuh, berhenti dan lapor), modul uang dan profit share.

## Bukti selesai
- Test API: outlet yang tidak ditugaskan tidak muncul (isolasi data), staf dengan 0, 1, dan banyak outlet. `LEGEND_TEST_FILES="..." pnpm test`.
- Lint + typecheck paket yang berubah lewat `heavy`; `pnpm exec prettier --check <berkas berubah>`; `pnpm db:generate` kosong.
- Screenshot pemilih outlet di lebar 390 dan 1280 (path berkas di laporan).
- Review: satu `reviewer` sonnet atas diff akhir, temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck` atau `tsc` gagal 2 kali di kartu yang sama: berhenti menebak. Baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error sekaligus, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
- Jam di laporan: ambil dari `date '+%H:%M'`.
- Di zsh, jangan pakai pola `F=("${(@f)$(git diff --name-only)}")` (memicu approval palsu); pakai `git diff --name-only | while read f`.

## Sebelum melapor
Commit di `ws/ebt9f-me-outlets` (satu commit per kartu), push cabang ke `origin`. Selesaikan kedua kartu, lalu lapor sekali.

## Laporan
Hasil, bukti (perintah dan hasilnya), file berubah, commit per kartu, jumlah subagent dan puncak bersamaan, risiko tersisa, yang dibutuhkan dari CTO.
