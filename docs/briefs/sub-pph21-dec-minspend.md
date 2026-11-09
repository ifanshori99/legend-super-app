# Sub-brief: PPh21 Desember gross_first (y2lf) dan basis min spend (v9fh)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pph21-dec-minspend` (cabang `ws/pph21-dec-minspend`). Semua perintah `cd` ke sini dulu dan cetak `pwd`. Jangan push/merge. Satu commit per kartu, pesan memuat ID kartu. Jangan `pnpm check` penuh. Berkas di luar scope: berhenti dan lapor.

## Kartu A: legend-y2lf (tingkat K, pajak) - implementer A
Berkas: `packages/shared/src/hris/payroll/pph21.ts` (fungsi `addedSplit`, `employeeAloneAdded`, ~baris 541-555) + test engine PPh21 yang ada (cari `gross_first` / `history-split` / H7 di `src/test` dan `packages/shared`), `docs/` catatan rilis.
Masalah: bagian karyawan di Desember skema `gross_first` = annual(P+G*) - annual(P) (P = seluruh pendapatan Jan-Nov), sedangkan saldo karyawan Jan-Nov = annual(Gs) - dibayar (Gs = bagian gross-scheme Jan-Nov, `priorGrossScheme`). Beda skala: karyawan bisa bayar lebih dari pajak gross-nya sendiri. H7: gross 60 jt setahun, pajak sendiri 150.000, engine membebani 237.500.
Keputusan founder Q52: bagian Desember `gross_first` = annual(Gs+G*) - annual(Gs), dibatasi (cap) D (D = added = taxOf(at).tax - history). Pakai `annualOf(priorGrossScheme + employeeG).annualTax - annualOf(priorGrossScheme).annualTax`. Rumus baru hanya bila `input.lastTaxPeriod && priorMix > 0n` (Gs diketahui); bila tidak (priorMix = 0) pertahankan perilaku lama dan tulis alasan di komentar. Jangan ubah jalur `proportional`, TER, atau penyelesaian saldo employeeBalance/employerBalance.
Perbarui komentar header pph21.ts (baris ~39) agar sesuai rumus baru.
Test gagal-dulu (jalankan dulu, lihat gagal, baru ubah kode): (1) kasus H7: beban karyawan total <= pajak sendiri dan sesuai rumus (angka tepat 150.000 bila skenarionya murni gross); (2) kasus tanpa gross-up (semua gross, tanpa employer scheme) hasil tidak berubah dari sebelumnya; (3) cap D tercapai; (4) priorMix = 0 tidak berubah. Test H lain yang sudah ada dan berubah angkanya karena rumus baru: perbarui hanya bila perubahan sesuai rumus, dan catat di komentar test (jangan melemahkan).
Catatan rilis: tambah di `docs/` (cari berkas catatan rilis/RELEASE-NOTES yang sudah ada; bila tidak ada, `docs/release-notes-pph21-december.md`): rumus baru PPh21 Desember gross_first WAJIB dicek konsultan pajak sebelum rilis.
Tulis juga `docs/briefs/256b-second-opinion-pph21-december.md` (brief Codex second-opinion, uang/pajak xhigh): konteks, rumus lama vs baru, file, contoh H7, pertanyaan (monoton? cap D benar? priorMix=0 fallback? kasus campuran proportional?), cara menjalankan test. Jangan dijalankan.
Beads: `ghostex board associate legend-y2lf`, `bd update legend-y2lf --status in_progress`.

## Kartu B: legend-v9fh (S) - implementer B
Keputusan founder Q53: minimum belanja promo dihitung dari harga SEBELUM pajak, juga di outlet harga termasuk pajak (inclusive). Exclusive tidak berubah.
Lokasi: `qr-order-pricing.ts` (~811), `crm-promo-minspend.ts:16`, web `bill-totals.tsx:135` (tampilan kekurangan min spend harus sama dengan API). Cari path dengan Grep. Jangan sentuh payroll, migrasi, refund.
Test gagal-dulu: order inclusive tepat di ambang (nilai termasuk pajak lolos tetapi sebelum pajak belum -> sekarang belum lolos; sebelum pajak tepat ambang -> lolos) + exclusive tidak berubah + tampilan web konsisten bila ada test web. Bila web disentuh: typecheck web lewat `heavy` (satu kali).
Beads: `ghostex board associate legend-v9fh`, `bd update legend-v9fh --status in_progress`.

## Bukti (tiap implementer)
`bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="<berkas test>" pnpm test'` (sebut jumlah file dan tes), eslint + `pnpm exec prettier --check` berkas berubah. Typecheck tidak dijalankan oleh implementer (agent induk menjalankan sekali lewat `heavy`). Lapor: SHA, file berubah, hasil test, risiko.
