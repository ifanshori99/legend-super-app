# Brief: engineer — QR dine-in memakai service charge default SC-DINE-IN (legend-xx22n)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/qr-service-charge-default` dari ujung `milestone/m1` terbaru, worktree `.worktrees/qr-service-charge-default`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-xx22n` (P1, tingkat K: uang dan pajak). Temuan Codex 133 atas brief 132 (`ws/service-charge-default`, sudah di m1): `tax-provisioning.service.ts:294` menyiapkan aturan default `SC-DINE-IN`, tetapi `qr-order-pricing.ts:673` hanya memuat aturan zona. Zona sah dengan `serviceChargeBp=0` menghasilkan service Rp0 dan checkout menyimpannya. Contoh subtotal Rp100.000: service Rp0 (seharusnya Rp5.000), PBJT Rp10.000 (seharusnya Rp10.500).
Perbaikan: QR pricing memuat aturan service published untuk outlet, sama seperti POS (cek cara POS memilih aturan service dan ikuti), lalu tetapkan presedensi terhadap zona. Usulan CTO: zona hanya menimpa default bila zona menyatakan nilai service secara eksplisit sebagai override; nilai 0 bawaan kolom bukan override. Bila skema zona tidak bisa membedakan "eksplisit 0" dan "tidak diisi", pakai aturan published, catat, dan lapor. Hasil QR dan POS untuk keranjang yang sama harus sama. Detail: `bd show legend-xx22n`, brief `docs/briefs/132-*.md` di folder utama.

## Kartu
`ghostex board associate legend-xx22n`, `bd update legend-xx22n --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `qr-order-pricing.ts`, pemuat aturan pajak/service yang dipakai QR, test. Jangan: `qr-order-consumers.ts` (cabang lain: legend-mks0q), `tax-provisioning.service.ts` selain baca, skema/migrasi (bila ternyata perlu: berhenti dan lapor, CTO memberi nomor; 0160 sudah dipesan cabang lain), POS pricing, refund, payroll, auth, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu di base: tenant/outlet baru dengan provisioning default, checkout QR dine-in subtotal Rp100.000 menghasilkan service Rp5.000 dan PBJT Rp10.500; zona dengan override eksplisit tetap dihormati; take-away QR tidak kena SC-DINE-IN; QR dan POS untuk keranjang sama memberi angka sama; lintas tenant tidak bocor. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/209b-second-opinion-qr-service-charge-default.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, presedensi yang dipilih dan alasannya, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
