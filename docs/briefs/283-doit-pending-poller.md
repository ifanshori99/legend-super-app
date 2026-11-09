# Brief: engineer (Sonnet) — DOIT resolver id pembayaran dan poller status pending

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/doit-pending-poller` dari `milestone/m1` (94995dad; sudah memuat `ws/doit-get-payment` cff27b49). Worktree `.worktrees/doit-pending-poller`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Migrasi hanya bila perlu: nomor dipesan `0190`, `when` 1794269000000.

## Tujuan
`legend-rfiof` (P2, tingkat K uang). `createDoitPaymentReader` (dari legend-6g29) belum punya pemanggil. Kurang:
1. Resolver: cari id pembayaran DOIT dari reference Legend (payment intent), termasuk bila id belum tersimpan.
2. Worker atau poller untuk payment intent `pending` yang lewat batas waktu: lease seperti job lain di `apps/api/src/worker`, batas jumlah per putaran, backoff saat DOIT galat.
3. Transisi status lewat jalur yang sama dengan webhook: idempoten, tidak pernah `paid` dari status tak dikenal, galat jaringan atau timeout tidak mengubah status lokal.

Keputusan yang masih menunggu founder (board Needs you DOIT): toleransi waktu tanda tangan, rotasi secret, dan apakah `expired`/`failed` boleh berubah ke `paid`. Jangan memutuskan sendiri: status akhir (`expired`, `failed`, `cancelled`, `refunded`) tidak diubah poller; bila DOIT melaporkan `paid` untuk intent yang sudah akhir, catat sebagai kasus atau alert untuk ditinjau, lalu tulis di laporan.

## Kartu
Awal: `ghostex board associate legend-rfiof`, `bd update legend-rfiof --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: adapter dan wire DOIT, service payment intent bagian transisi, worker job baru, test. Jangan: refund flow, settlement (legend-cs7), kas-bank, verifier tanda tangan, UI. Kunci DOIT: hanya nama key dari `.env.example`, jangan baca `.env*`.

## Bukti selesai
- Test gagal-dulu: intent pending yang lewat batas dicek dan berubah benar; dua worker bersamaan tidak memproses intent yang sama (lease); webhook dan poller untuk event yang sama hanya mengubah status sekali; status tak dikenal tidak jadi `paid`; galat jaringan tidak mengubah status; intent berstatus akhir tidak diubah.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck api lewat `heavy` sekali; eslint + prettier berkas berubah.
- Review (Q48, tingkat K): satu subagent `architect`.
- Tulis brief Codex `docs/briefs/283b-second-opinion-doit-poller.md`, jangan dijalankan.

## Laporan
Sekali di akhir: SHA, migrasi (ada/tidak), bukti, file berubah, perilaku untuk status akhir, risiko, jumlah subagent dan puncak bersamaan.
