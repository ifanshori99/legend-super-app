# Brief: engineer — pemetaan sender Kirimdev ditulis platform saja

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (akses + migrasi).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/kirim-whatsapp` (7f631e6f). Push ke `origin` sebagai `fix/kirimdev-sender-mapping`.

## Kartu `legend-nqxtb` (keputusan CTO; jangan ditanyakan)
`apps/api/src/services/messaging-kirimdev.ts`: resolver sender percaya `tenant_integrations.config.phoneNumberId` yang ditulis admin tenant. Satu `KIRIM_API_KEY` platform bisa kirim dari semua nomor organisasi Kirimdev, jadi tenant A bisa klaim nomor B.
Benar:
- Tabel pemetaan sender (tenant/outlet -> phone_number_id) yang hanya ditulis admin platform (`requirePlatformAdmin` + `requireSessionMfa`), dengan audit. phone_number_id unik lintas tenant.
- Resolver hanya membaca pemetaan itu; nilai di config tenant diabaikan. Tanpa pemetaan: fail-closed (tidak kirim, error jelas tanpa nomor/token).
- Tenant tidak bisa membaca nomor tenant lain.
Adapter tetap tanpa pemanggil.

`bd update legend-nqxtb --status in_progress` di awal; lapor `--status review` + `bd comment`.

## Migrasi
Rentang `0470-0471` saja. `db:generate` kosong setelahnya; RLS sesuai pola tabel platform lain.

## Pembagian paralel
Explore (pola tabel/route admin platform + RLS), test-writer (gagal-dulu: tenant A klaim nomor B ditolak; tanpa pemetaan fail-closed; non-platform-admin 403; tanpa MFA ditolak), implementer 2 (schema+migrasi; service+route), satu `architect` effort xhigh atas diff, satu `test-runner` pemegang heavy.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; typecheck api via `heavy`; prettier + eslint; `db:generate` kosong. Antrean heavy panjang: jalankan typecheck sekali di akhir.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy; jangan panggil Kirimdev sungguhan. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
