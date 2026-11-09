# Brief: engineer (Sonnet) — kirim ulang status ke platform delivery

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/delivery-platform-retry` dari `ws/delivery-ops-fixes` (daa6b3ac, legend-bk99; antre merge train). Worktree `.worktrees/delivery-platform-retry`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

Migrasi bila perlu: `0179`, `when` 1794258000000.

## Tujuan
`legend-r7vxn` (P1). Keputusan founder Q56: bila GoFood/GrabFood mati atau menolak update status, pesanan tetap jalan di outlet; sistem mengirim ulang otomatis; pesanan yang belum sinkron ditandai di layar staf.
- Sejak bk99, panggilan platform (accept/update/cancel) adalah intent pasca-commit; gagal hanya diaudit `platform_desync` (`refused`/`unknown`). Tambahkan sweep di worker yang mengirim ulang intent `unknown` dengan backoff dan batas percobaan, idempoten (tidak mengirim dua kali status yang sudah diterima platform).
- `refused` (platform menolak dengan jawaban jelas): jangan diulang buta; tandai pesanan perlu tindakan staf.
- Status sinkron per pesanan terbaca di API pesanan delivery (mis. `platformSync: ok | retrying | needs_action`) supaya layar staf bisa memberi tanda. UI layar staf tidak di sini; sebut kontraknya di laporan dan buat kartu UI.

## Kartu
Awal: `ghostex board associate legend-r7vxn`, `bd update legend-r7vxn --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: service/worker delivery, outbox delivery intent, route delivery orders (field baca), validator/tipe `packages/shared`, test, migrasi 0179 bila perlu. Jangan: payment/refund, pickup/expo, UI.

## Bukti selesai
- Test gagal-dulu: intent `unknown` dikirim ulang sampai sukses lalu berhenti; batas percobaan tercapai jadi `needs_action`; `refused` tidak diulang; dua worker bersamaan tidak mengirim ganda; field status sinkron terbaca.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck paket yang berubah lewat `heavy` sekali di akhir; eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48): satu `architect` (outbox dan worker konkuren).

## Laporan
Sekali di akhir: hasil, SHA, migrasi (ada/tidak), bukti, file berubah, kontrak untuk UI, id kartu UI baru, risiko, jumlah subagent dan puncak bersamaan.
