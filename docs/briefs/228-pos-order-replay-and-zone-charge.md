# Brief: engineer — POS order: replay idempoten lintas deploy dan biaya layanan zona saat reprice (legend-3k8no, legend-k7x4p)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/pos-order-replay-zone-charge` dari ujung `milestone/m1` terbaru. Worktree `.worktrees/pos-order-replay-zone-charge`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Dua kartu di area order POS. Kerjakan paralel lewat subagent `implementer` bila berkasnya tidak bertumpuk.
- `legend-3k8no` (P2): `apps/api/src/routes/pos-order.routes.ts:141` — retry dengan `idempotencyKey` yang disimpan sebelum deploy mengembalikan JSON lama tanpa `version` (sekarang wajib); repro: HTTP 200 dengan ETag "7" tetapi validasi respons gagal. Perbaikan: replay menghasilkan snapshot dan `version` yang konsisten dengan ETag tanpa mengulang mutasi (misal isi `version` dari DB saat replay). Tambah test lintas deploy (baris idempoten format lama).
- `legend-k7x4p` (P2, uang): `pos-order.service.ts:671-674` memberi biaya layanan zona bila order punya sesi meja; reprice `pos-order-support.ts:889-892` hanya untuk `dine_in`; aturan zona sintetis `orderTypes: []` (`qr-order-pricing.ts:575`). Pertama buktikan dulu apakah order takeaway di sesi meja bisa ada (lewat API, bukan sisip SQL). Bila tidak bisa: tutup celahnya dengan test yang membuktikan, komentar di kartu, tanpa ubah kode. Bila bisa: samakan create dan reprice (aturan mana yang benar: baca PRD `docs/PRD.md` soal biaya layanan zona; bila PRD tidak jelas, ikuti create dan tanyakan di laporan).

## Kartu
`legend-3k8no`, `legend-k7x4p`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Scope
Boleh: berkas di atas, service/route order POS terkait, kontrak shared order POS bila perlu, test. Jangan: refund, write-off, pajak, PIN edge, platform/Owner, migrasi (bila perlu, minta nomor ke CTO dulu), UI.

## Bukti selesai
- Test reproduksi gagal dulu di basis, lalu lulus. Test order POS dan QR pricing lama tetap lulus.
- `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...` relatif ke `apps/api`) lewat `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'` dari root worktree, sebut jumlah file.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier untuk berkas berubah. Jangan jalankan `pnpm check` penuh.
- k7x4p menyentuh uang: subagent reviewer Opus + architect paralel; 3k8no cukup reviewer Sonnet. Bila k7x4p berubah kode, tulis brief Codex `docs/briefs/228b-second-opinion-pos-zone-charge.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil per kartu, bukti (perintah dan hasil), file berubah, SHA, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep; tunggu notifikasi job sendiri. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
