# Brief: engineer — sinkron PIN edge-cloud dan audit override edge

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edge-pin-sync` dari ujung `milestone/m1` terbaru, worktree `.worktrees/edge-pin-sync`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan (tiga kartu, tingkat K, paralel lewat subagent, file tidak bertumpuk)
1. `legend-t9ii` (P2): versi sinkron PIN cloud ke edge memakai urutan commit (kolom versi/sequence), bukan `created_at`/`updated_at` + settle 5 detik; edge membandingkan dengan `pin_set_at`. Jam edge yang tertinggal tidak boleh membuat PIN edge yang lebih baru kalah.
2. `legend-zclb` (P2): job edge sekali jalan yang memancarkan ulang `staff_pin.set` dengan material untuk PIN edge yang lebih baru dari cloud (set PIN v1 lama tanpa material dan baris parkir v1). Idempoten, aman saat standby ambil alih.
3. `legend-7iti` (P2): `applyPosOverrideRecorded` (`apps/api/src/edge/access-applier.ts`) mencatat override tutup shift dari edge ke audit cloud tanpa varians. Keputusan CTO: audit cloud membawa expected, counted, selisih seperti override di cloud.
Detail: `bd show <id>`; konteks desain: `bd show legend-kyie`.

## Kartu
`ghostex board associate` ketiganya, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: ekspor/impor PIN edge, `apps/api/src/edge/access-applier.ts`, skema/migrasi PIN (bila perlu kolom versi), job edge baru, test. `edge/runtime.ts` hanya untuk mendaftarkan job sekali jalan (catat di laporan). Jangan: `pos-shift.service.ts`, modul refund, auto-journal, payroll, open bill, `app.ts`, `routes/index.ts`, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: jam edge tertinggal 10 menit tetap memenangkan PIN edge yang lebih baru; PIN v1 offline sampai ke cloud setelah job; audit override edge berisi varians. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob dengan jumlah file jalan. `node --test tests/*.test.mjs` lewat `pnpm test` (suite PostgreSQL butuh DB terisolasi). tsc lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/183b-second-opinion-edge-pin-sync.md` di folder utama (tidak di-commit). Migrasi: nomor + `when` di atas 1794220000000, merge train menomori ulang.

## Laporan
Sekali setelah ketiganya selesai: hasil, bukti, file berubah, SHA, migrasi, urutan rilis edge vs cloud, risiko tersisa. Jangan menunggu proses global (`pgrep vitest` milik agent lain); `heavy` mengatur antrean. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
