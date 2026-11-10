# Brief 125: engineer — eskalasi refund yang lama tertunda (legend-n9kn)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (refund): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base: `ws/doit-refund` (5316426a, belum di m1; berisi alur payout dan sweep refund terbaru).
`git worktree add .worktrees/refund-escalation -b ws/refund-escalation ws/doit-refund`. Jangan pakai `--worktree` Ghostex.

## Tujuan
Refund yang tertunda terlalu lama tidak diam selamanya: manajer diberi tahu dan refund dieskalasi, dengan jejak audit.

## Keputusan CTO (9 Nov 2026, founder boleh mengubah)
- Tidak ada kedaluwarsa otomatis. Refund tertunda tidak pernah dibatalkan atau dibayar otomatis karena umur.
- Ambang umur bisa diatur per tenant sebagai data (default: 24 jam untuk refund pending tanpa rantai persetujuan; 72 jam untuk refund yang provider-nya terus menjawab "pending").
- Lewat ambang: tandai sekali sebagai tereskalasi (idempoten), tulis audit, kirim notifikasi ke manajer outlet dan finance lewat jalur notifikasi yang sudah ada, dan tampilkan di daftar rekonsiliasi.

## Kartu
`legend-n9kn`. Di awal: `ghostex board associate legend-n9kn` dan `bd update legend-n9kn --status in_progress`. Saat melapor: `bd update legend-n9kn --status review` dan `bd comment legend-n9kn "<ringkasan bahasa biasa>"`.

## Masukan
- `bd show legend-n9kn` (deskripsi dan catatan).
- `payment-refund.service.ts`, `sweepApprovedRefundPayouts` (sudah dijalankan worker).

## Scope
- Boleh diubah: `payment-refund.service.ts` dan modul sweep refund, layanan notifikasi (pemakaian saja), test di `apps/api/src/test/`, migrasi baru bila perlu (penanda eskalasi, ambang per tenant).
- Jalankan pemeriksaan eskalasi di dalam sweep yang sudah terdaftar. Jangan ubah `apps/api/src/worker-main.ts`, `app.ts`, `routes/index.ts` (sedang diubah penggabungan tahap 3). Bila tidak bisa dihindari, berhenti dan laporkan dulu.
- Jangan disentuh: adapter DOIT dan webhook refund, `crm-promo-refund.ts`, `refundPosOrder`.

## Bukti selesai
- Test: refund di bawah ambang tidak berubah; lewat ambang tereskalasi sekali (sweep dua kali tidak menggandakan notifikasi atau audit); tidak ada perubahan status uang; isolasi tenant; ambang per tenant dihormati.
- `LEGEND_TEST_FILES="<file test baru dan yang terdampak>" pnpm test` dari root worktree.
- Lint dan typecheck lewat `heavy`. `pnpm db:generate` kosong atau migrasi baru tercatat.

## Sebelum melapor
Commit lokal di `ws/refund-escalation`, hanya file dalam scope. Jangan push. Tulis brief second-opinion Codex di `docs/briefs/126-second-opinion-refund-escalation.md` (folder proyek, jangan commit): rentang diff non-test maks 800 baris per run, berkas berisiko, invariant. Jangan sebut temuan review Claude.

## Laporan
SHA awal..akhir, migrasi (nomor), hasil gate, temuan review K, file berubah, bead baru, risiko tersisa.
