# Brief 149: engineer — bersihkan PAN lama di data EDC (legend-5gub)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (data kartu/pribadi): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/edc-pan-scrub -b ws/edc-pan-scrub milestone/m1`. Jangan pakai `--worktree` Ghostex.
Sebelum mulai: cek apakah sudah dikerjakan di `integ/m1-batch3/4/5` (`git log --all --grep`, `git grep`). Bila sudah, `bd comment` dengan bukti dan selesai.

## Tujuan
`bd show legend-5gub`. Penulisan baru sudah aman (brief 102). Data lama bisa berisi nomor kartu penuh (PAN) di `edc_transactions` (`card_type`, `rrn`, `invoice_no`, `batch_no`, `message`).
1. Query read-only untuk mendeteksi pola PAN (13-19 digit, termasuk yang dipisah spasi/strip) di kolom itu. Jalankan di DB dev lokal, catat jumlahnya.
2. Migrasi data yang menyamarkan PAN di baris lama: idempoten, tanpa mengubah baris bersih, tanpa mengubah jumlah atau status transaksi. Laporkan nomornya (nomor akan diregenerasi di merge train). Sertakan cara menjalankannya di luar jam operasional bila tabel besar.
3. Review `logger.warn/error` di `apps/api/src/edge/edc/agent.ts` dan jalur EDC lain: data kartu tidak boleh tercatat di log. Perbaiki bila ada.
Di awal: `ghostex board associate legend-5gub`, `bd update legend-5gub --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: modul EDC (`edge/edc/*`, service/schema EDC), migrasi baru, test di `apps/api/src/test/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, modul pembayaran DOIT, refund, POS order.

## Bukti selesai
- Test: baris berisi PAN tersamarkan, baris bersih tidak berubah, migrasi dijalankan dua kali hasil sama, log tidak memuat PAN, isolasi tenant.
- `LEGEND_TEST_FILES="<file terkait>" pnpm test`, typecheck dan lint lewat `heavy`, `pnpm db:generate` kosong atau migrasi tercatat.
- Commit lokal di `ws/edc-pan-scrub`, jangan push. Tulis `docs/briefs/150-second-opinion-edc-pan-scrub.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant, tanpa temuan review Claude.

## Laporan
SHA awal..akhir, migrasi, jumlah baris terdeteksi di dev, hasil gate, temuan review K, bead baru.
