# Brief: engineer — kartu kecil platform, POS, keamanan

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree baru dari `milestone/m1`, cabang `ws/platform-pos-security-small`.

## Tujuan
Selesaikan empat kartu P2 yang filenya terpisah.

## Kartu
`legend-bag1` (kontrak audit lintas tenant + health platform), `legend-ptp2` (test HTTP penjualan non-tunai tanpa device pada urutan struk cloud C), `legend-ykam` (appHomePath masih /notes, arahkan ke dashboard back-office), `legend-2ywn` (audit provisioning DB memakai baseline hak bawaan tepercaya, bukan denylist). Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- `bd show <id>` tiap kartu (kriteria di sana).
- Kartu ternyata sudah selesai di `milestone/m1`: tutup dengan bukti commit, jangan dikerjakan ulang.
- `legend-ptp2` hanya menambah test. Bila test menunjukkan bug uang (struk/nomor dobel, jumlah salah), jangan ubah logika uang; lapor ke CTO.

## Scope
- Boleh diubah: kontrak/validator platform di `packages/shared`, route platform di `apps/api`, test POS, konfigurasi home path di `apps/web`, script/test audit provisioning DB.
- Jangan disentuh: accounting, payroll, payout, edge, finance-exceptions, reports/metrics, ops checklist.
- Migrasi: rentang `0553-0554` saja bila perlu. Jangan hapus volume Docker apa pun.

## Pembagian paralel (giliran pertama)
- Explore (2): bag1+ykam; ptp2+2ywn.
- test-writer: test gagal-dulu per kartu (2ywn: audit gagal bila PUBLIC punya EXECUTE pada fungsi admin).
- implementer: 4, satu per kartu, file tidak bertumpuk.
- Pemegang token heavy: satu test-runner.

## Bukti selesai
- `LEGEND_TEST_FILES="<test tiap kartu>" heavy pnpm test` hijau, tercatat gagal-dulu.
- ykam mengubah routing: jalankan e2e terarah yang menyentuh redirect setelah login (lewat heavy) bila ada.
- Pra-gate AGENTS.md: prettier, eslint, `pnpm db:generate` kosong, typecheck api + web lewat `heavy`.
- Review: 2ywn = keamanan, satu `architect` effort high; sisanya satu `reviewer` sonnet. Temuan nyata dibetulkan.
- Commit lokal; push ke cabang kerja boleh. Jangan merge ke milestone/main.

## Batas kerja ulang (Retro 11)
- `typecheck` gagal 2 kali di kartu yang sama: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, jalankan sekali lagi. Gagal ketiga: lapor ke CTO dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
