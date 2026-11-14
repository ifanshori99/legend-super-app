# 820 Cabut HP terdaftar push alarm panik walau sesinya kedaluwarsa (engineer, tingkat K akses)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md, `~/.agents/team/ui-standard.md`, dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/ws/panic-push-registration` (c41dacbd7). Cabang akhir `fix/panic-push-device-revoke` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-gchkf`. Di awal `bd update legend-gchkf --status in_progress`; saat lapor `--status review` + `bd comment`.

## Masalah
Dari architect 806: `listOwnSessions` (`apps/api/src/services/identity-session.service.ts` ~259) menyembunyikan sesi kedaluwarsa. HP yang hilang dan sesinya habis tetap menerima push alarm panik sampai user menekan "cabut sesi lain".

## Keputusan CTO
- Tampilkan daftar perangkat push terdaftar milik user sendiri (termasuk yang sesinya sudah habis), dengan tombol cabut per perangkat. Cabut = langganan push dihapus/nonaktif, tidak ada push lagi ke perangkat itu.
- Hanya perangkat milik user yang login (filter user ID di SQL); route lewat `requireAuth` + `requireTrustedOrigin`; ID divalidasi schema shared.
- Bila ragu, pilih yang berhenti mengirim push.

## Scope
- Boleh: service/route identity-session dan push subscription, validator shared, layar sesi/perangkat di web yang sudah ada, katalog text-contract, test.
- Jangan: migrasi (bila perlu kolom baru: berhenti dan lapor, nomor 0380), logika pemicu alarm panik, pembayaran, edge, pemindai.

## Paralel
- Explore x2: (a) tabel/servis push subscription dan pengiriman push panik, (b) layar sesi web dan pola komponennya.
- test-writer: test API (daftar termasuk sesi kedaluwarsa, cabut menghentikan push, user lain tidak bisa melihat/mencabut, 401/403) gagal-dulu di basis.
- implementer x2: API dan web (file tidak bertumpuk).
- ui-auditor: audit layar akhir.
- Pemegang token heavy: test-runner.

## Bukti selesai
- Test terarah lewat `heavy`, gagal-dulu tercatat.
- Screenshot layar perangkat 390px dan 1280px di `docs/screenshots/820-*.png` (`heavy ghostex visual check` atau Playwright lewat `heavy`).
- Pra-gate AGENTS.md (prettier, eslint, text-contract, `heavy pnpm --filter @starter/api typecheck` dan `@starter/web typecheck`).
- Satu subagent architect effort xhigh atas diff; temuan nyata dibetulkan.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, cabang akhir, test, path screenshot, hasil architect, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
