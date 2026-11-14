# Brief: engineer (Codex) — payload event domain cloud->edge toleran (legend-pitm6 sisa)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend` (worktree dari `--worktree`), base cabang `fix/edge-snapshot-tolerant` (49dea22d4, di atas fix/edge-uom-issystem). Cabang akhir: `fix/edge-domain-payload-tolerant`.

## Tujuan
Edge yang lebih lama tidak boleh menolak data dari cloud hanya karena ada field baru. Envelope dan skema di `packages/shared/src/edge` sudah toleran (f2b452e66, 49dea22d4). Sisa: payload event domain yang dikirim cloud->edge di luar `packages/shared/src/edge` masih strict. Buat parse sisi edge toleran (strip field tak dikenal, bukan tolak).

## Kartu (isi bd, agent Codex tidak menjalankan bd)
legend-pitm6: "skema snapshot edge strict, jadi edge lama menolak snapshot yang punya field baru. Setelah go-live tiap field baru memutus sync. Parse snapshot toleran field tak dikenal (strip, bukan tolak). Wajib sebelum gerbang rilis."
Keputusan CTO (tetap): parse cloud->edge toleran (strip) KECUALI promo/voucher tetap strict di edge (uang); varian sisi cloud tetap strict. Jangan longgarkan validasi input dari edge ke cloud.

## Scope
- Boleh: skema/validator payload event domain yang dipakai jalur edge (apps/edge atau setara, packages/shared bagian event domain), test terkait.
- Jangan: promo/voucher (tetap strict), validator API cloud untuk input pengguna, migrasi (tidak ada nomor migrasi untuk kartu ini).

## Pembagian paralel (giliran pertama)
- Explore (2): (a) cari semua parse payload event domain di jalur cloud->edge di luar packages/shared/src/edge; (b) pola toleran yang sudah dipakai f2b452e66/49dea22d4.
- test-writer: test gagal-dulu: payload domain dengan field tambahan diterima edge dan field-nya dibuang; payload promo/voucher dengan field tambahan tetap ditolak. Jalankan terhadap base, catat yang merah.
- implementer: satu per kelompok file payload (tidak bertumpuk).
- Pemegang token heavy: satu subagent saja.

## Bukti selesai
- Test terarah: `LEGEND_TEST_FILES="<file test>" heavy pnpm test` (atau `heavy vitest run <path>` untuk paket edge).
- Pra-gate AGENTS.md: prettier, eslint pada file diubah; typecheck paket tersentuh sekali lewat `heavy`.

## Batas kerja ulang
- Typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua, jalankan sekali lagi; gagal ketiga lapor dengan log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit hanya file scope, rename cabang `ghostex/...` ke `fix/edge-domain-payload-tolerant`, `git push -u origin fix/edge-domain-payload-tolerant` tanpa force. Jangan merge ke main atau milestone.

## Laporan
Hasil, bukti (perintah dan hasil), file berubah, commit, cabang akhir yang di-push, test gagal-dulu yang merah di base, risiko tersisa. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
