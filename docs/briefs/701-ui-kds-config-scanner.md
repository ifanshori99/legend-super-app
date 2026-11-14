# Brief: ui-engineer — stasiun dapur dan scanner KDS (legend-sonf, legend-uqfu)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti. Semua kerja UI ikut `~/.agents/team/ui-standard.md`. Tugas sedang: Sonnet cukup bila tidak ada desain baru.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`. Cabang akhir `ui/kds-config-scanner`.

## Tujuan
Founder menyetujui mockup (W12 Q9, 14 Nov): cabang `design/kds-config-scanner` 8e8e4ca2f, `design/mockups/pos/kds-review.html`, `pos-extra-kds-sonf-konfigurasi.html`, `pos-extra-kds-uqfu-scanner.html` (desktop 1280 + HP 390).
- legend-sonf: atur urutan tab stasiun dapur, aktif/nonaktif, cetak cadangan (menyala saat tablet dapur tidak merespons).
- legend-uqfu: input scanner di KDS; bila scanner terputus, tombol di tiket tetap bisa dipakai manual.
Keadaan kosong, memuat, error, gagal simpan, sukses. Bila badge jumlah per tab dibutuhkan, kerjakan juga legend-v4ht (SegmentedControl badge opsional). Bila API belum ada, pakai mock dan catat celah kontrak sebagai kartu bd baru (discovered-from kartu terkait); jangan ubah server.

## Kartu
`legend-sonf`, `legend-uqfu` (aturan kartu: `~/.agents/team/brief-template.md`). Teks UI baru didaftarkan ke katalog (`node --test tests/text-contract.test.mjs`).

## Bukti selesai
Screenshot tiap keadaan 1280 dan 390 (`docs/screenshots/kds-config-scanner/`), ui-auditor sebelum lapor, test web terkait hijau, pra-gate AGENTS.md (prettier, eslint, typecheck web lewat heavy).

## Sebelum melapor
Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
