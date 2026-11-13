# Brief: engineer — tiga kartu lanjutan kecil (WA inbound, printer edge, alert Brevo)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet; tiap kartu file terpisah -> satu `implementer` per kartu dalam satu giliran, `Explore` per kartu dulu.

## Repo
Worktree baru dari `milestone/m1` (a2234853d): `git worktree add .worktrees/followups-640 -b ws/followups-640 milestone/m1`, lalu `pnpm worktree:setup`. Rentang migrasi bila perlu: **0500-0503** (jangan pakai nomor lain).

## Kartu
1. `legend-3hb1n` (P2, akses/auth) — WA inbound: cek kanal live sebelum `resolveWhatsAppAccount` (`identity-wa-inbound.service.ts` ~:481/:711). Detail di `bd show legend-3hb1n`. Test gagal-dulu: challenge lama tanpa kanal live tidak membuat akun dan tidak menulis audit ke tenant pengklaim.
2. `legend-fbf4v` (P2, sinkron offline) — sinkron registry printer cloud ke edge (CRUD printer dari ws/edge-device-security sudah di m1). Ikuti pola sinkron registry edge yang sudah ada; isolasi per tenant/outlet wajib diuji.
3. `legend-65i3t` (P3) — pasang `notifyBrevoAuthFailed` di `createStatementEmailProvider`; 401/403 memicu alert.

## Review
Kartu 1 dan 2 tingkat K (akses, sinkron offline): satu subagent `architect` effort high (kartu 1: "architect effort xhigh") atas diff gabungan. Kartu 3: cukup reviewer sonnet. Maks 2 ronde architect.

## Bukti selesai
Test terarah lewat `heavy` (LEGEND_TEST_FILES), typecheck api lewat `heavy` sekali sebelum lapor, prettier + eslint atas berkas berubah, `db:generate` kosong. Push cabang (tanpa force). `bd update <id> --status review` + `bd comment` per kartu.

## Batas
Jangan merge ke m1/main, jangan deploy, jangan `pkill`. Hemat token: jangan baca ulang file besar; kuota akun terbatas.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
