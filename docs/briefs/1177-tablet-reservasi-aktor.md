# 1177 Tablet bersama: aktor reservasi + flake + perf i18n (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer + implementer per area; area A satu implementer karena berkas sama).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `milestone/m1` (d99aae067). Cabang kerja: `ws/1177-tablet-reservasi-aktor`. Tingkat K (akses): architect effort xhigh atas area A sebelum lapor. Tanpa migrasi; bila perlu: berhenti dan lapor ke CTO.

## Kartu (baca `bd show <id>`)
A. (berkas sama, berurutan) `legend-5f6is` lalu `legend-jvaqa`
- 5f6is: `reservation.routes.ts` (~163, 180, 199, 220, 328) dan `assertPermission` di `reservation-booking.ts` (~741) memakai `actorOf(req)` (kasir ber-PIN di tablet bersama), bukan pemilik sesi. Test: di tablet bersama audit/aktor = kasir; kasir tanpa `reservation.manage` ditolak walau pemilik sesi punya; perangkat biasa tidak berubah.
- jvaqa: seat + PATCH tables reservasi dibuka di tablet bersama via `requireAuthAllowSharedDevice` + `requireActingStaffOnSharedDevice`. Test: tanpa PIN kasir 403 seragam; dengan PIN sukses dan aktor kasir.
B. `legend-v1l1f` flake isolasi `hris-overtime-collective-db` (QUOTA_EXCEEDED di suite penuh): tenant/kuota kursi sendiri per test. Bukti: berkas itu + satu berkas hris lain bersamaan 3x hijau.
C. `legend-0rzwb` perf web i18n: pecah namespace core per key (label `features/*/nav.ts`), target core jauh lebih kecil (catat ukuran sebelum/sesudah). Lighthouse sekali lewat `heavy --exclusive` hanya bila jalur sepi; bila tidak, lapor ukuran bundle saja. Text-contract wajib hijau.

## Batas
- Jangan sentuh: `payment-webhook*`, `order-given.ts`, `reservation-core.ts`, `reservation-deposit*`, `facility-slots*`, `edge-*`, `access.service.ts`, `platform-approval.service.ts`, `pos-receipt*`.

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), typecheck api + web lewat `heavy` sekali masing-masing dengan exit code di laporan, prettier + eslint file berubah, `node --test tests/text-contract.test.mjs`. Tunggu job heavy dengan Bash run_in_background (notifikasi exit), jangan akhiri giliran dengan kabar tunggu dan jangan loop pgrep proses milik thread lain. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji. Lapor sekali.
