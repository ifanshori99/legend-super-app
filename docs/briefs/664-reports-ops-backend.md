# Brief: engineer — WS-11 laporan + WS-14 ops backend

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree baru dari `milestone/m1`, cabang `ws/reports-ops-backend`.

## Tujuan
Selesaikan empat kartu backend P2 yang filenya terpisah: penerima laporan terjadwal, agregasi `metrics_daily` non-uang, izin `ops.checklist.manage`, dan pemasangan `PrepProductionOrderCreator` untuk prep selesai.

## Kartu
`legend-rmvu`, `legend-24nl`, `legend-wg0g`, `legend-qq4k`. Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- `bd show <id>` tiap kartu (kriteria penerimaan di sana).
- `legend-24nl`: commit 981abe324 menunda `metrics_daily`; lihat `apps/api` dashboard catalog (sekitar `catalog.ts:224-330`).
- `legend-qq4k`: cek dulu apakah menyentuh nilai uang (biaya bahan/HPP). Bila ya: berhenti di kartu itu, lapor ke CTO sebelum mengubah logika uang.

## Scope
- Boleh diubah: route/service/test laporan, dashboard/metrics, ops checklist, ops/prep di `apps/api`; `packages/shared/src/permissions.ts` dan validator/DTO terkait.
- Jangan disentuh: modul accounting, payroll, payout, edge, finance-exceptions, POS pembayaran.
- Migrasi: rentang nomor `0550-0552` saja. Jangan menomori ulang migrasi lain. Jangan hapus volume Docker apa pun.

## Pembagian paralel (giliran pertama)
- Explore (3): rmvu+wg0g (reports routes, permissions, ops checklist routes); 24nl (dashboard catalog, job agregasi yang ada); qq4k (WS-06 PrepProductionOrderCreator dan alur prep selesai).
- test-writer: test gagal-dulu vitest API per kartu, termasuk isolasi tenant (penerima laporan hanya user tenant pemanggil; izin checklist ditolak tanpa permission).
- implementer: 4, satu per kartu, file tidak bertumpuk (permissions.ts hanya milik implementer wg0g).
- Pemegang token heavy: satu test-runner.

## Bukti selesai
- `LEGEND_TEST_FILES="<test tiap kartu>" heavy pnpm test` hijau, tercatat gagal-dulu sebelum fix.
- Pra-gate AGENTS.md: prettier, eslint, `pnpm db:generate` kosong, typecheck api (+ web bila shared berubah) lewat `heavy`.
- Satu review sonnet `reviewer` atas diff cabang; temuan nyata dibetulkan.
- Commit lokal di cabang kerja; push ke cabang kerja boleh. Jangan merge ke milestone/main.

## Batas kerja ulang (Retro 11)
- `typecheck` gagal 2 kali di kartu yang sama: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, jalankan sekali lagi. Gagal ketiga: lapor ke CTO dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
