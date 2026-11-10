# Brief: ui-engineer — open bill oleh supervisor + kebijakan open bill outlet (rilis pertama)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md`, `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai) dan `~/.agents/team/ui-standard.md`, lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/open-bill-r1` dari ujung `milestone/m1` terbaru, worktree `.worktrees/open-bill-r1`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Konteks bisnis (keputusan founder)
- Q31: open bill bukan hanya owner. Supervisor atau manager yang bertugas bisa mengubah meja/tamu jadi open bill (bayar belakangan), dan batasnya bisa diatur lewat pengaturan outlet.
- Q32 = B: masuk rilis pertama.
- F&B: kebanyakan bayar dulu baru disajikan; open bill hanya untuk area atau tamu tertentu.

## Kartu
`legend-8cm4` (supervisor+ ubah sesi meja berjalan jadi open bill, PIN + audit, dalam batas kebijakan outlet) dan `legend-2zb5` (endpoint + layar kebijakan open bill outlet: batas nilai bill default Rp3 juta, menit tidak aktif 45, SLO permintaan bill). Di awal: `ghostex board associate` keduanya, `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`.

## Urutan (gerbang founder tetap)
1. **UI dulu.** Dengan komponen dan pola layar yang sudah ada (POS sesi meja, `/kelola`): aksi "Jadikan open bill" di sesi meja (sheet konfirmasi + PIN supervisor, alasan, tampilkan batas outlet), dan form kebijakan open bill outlet di `/kelola`. Data contoh/stub boleh. Screenshot lebar sempit (390) dan lebar (1280), state kosong/error/ditolak batas. `ui-auditor` sebelum lapor. Lapor ke CTO dan **berhenti**: founder meninjau UI dulu.
2. **Setelah CTO meneruskan OK founder:** kontrak shared (validator + DTO), permission aksi sempit baru (bukan `floor.table.manage`) untuk supervisor ke atas, route kebijakan (outlet_manager ke atas) memakai `upsertOpenBillPolicy` (`open-bill-control.service.ts`), aksi ubah sesi dengan PIN + audit + dihormati `outlet_open_bill_policies`, test isolasi tenant/outlet dan peran, sambungkan UI ke API.

## Scope
Boleh: layar POS sesi meja dan `/kelola` terkait open bill, `features/open-bill*` di web, `open-bill-control.service.ts`, route open bill baru, `permissions.ts`/roles (aksi baru saja), validator/DTO open bill, test. Jangan: `pos-shift.service.ts`, modul refund, auto-journal, payroll, `edge/runtime.ts`. `routes/index.ts` dan `app.ts` hanya untuk mendaftarkan router baru (satu baris, catat di laporan).

## Bukti selesai
Langkah 1: screenshot + hasil `ui-auditor`. Langkah 2: test reproduksi peran (supervisor bisa, kasir tidak, outlet lain tidak), `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob dengan jumlah file jalan, test root kontrak (`node --test tests/*.test.mjs`, `^ℹ pass`), tsc lewat `heavy`, eslint, prettier. Aksi auth/uang = tingkat K: reviewer Opus + architect paralel, brief Codex `docs/briefs/180b-second-opinion-open-bill.md` (tidak di-commit).

## Laporan
Langkah 1: satu laporan dengan path screenshot. Langkah 2: hasil, bukti, file berubah, SHA, migrasi (nomor + `when`, merge train menomori ulang). Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
