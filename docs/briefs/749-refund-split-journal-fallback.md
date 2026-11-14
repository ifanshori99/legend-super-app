# Brief: engineer — jurnal split refund tanpa baris payment_refunds (legend-qte35, UANG)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend` (worktree), base `milestone/m1`. Cabang akhir: `fix/refund-split-journal-fallback`.

## Tujuan
Hardening dari architect batch63: bila baris `payment_refunds` tidak ada, bagian split refund saat ini diam-diam dijurnal ke `gateway_clearing` (bukan `customer_deposit`). Itu salah akun dan bisa membuat buku tidak seimbang dengan kenyataan. Perbaiki: cari sumber lewat `orders.payment_intent_id`; bila tetap tidak bisa dipastikan, parkir jurnal untuk retry (jangan tebak akun). Jangan sampai rugi: tidak ada jurnal yang menggandakan refund atau membayar lebih.

## Kartu
`legend-qte35`. Di awal: `ghostex board associate legend-qte35` dan `bd update legend-qte35 --status in_progress`. Saat melapor: `bd update legend-qte35 --status review` dan `bd comment legend-qte35 "<ringkasan>"`.

## Scope
- Boleh: service jurnal otomatis refund di apps/api (cari lewat Explore), test di apps/api/src/test/.
- Jangan: alur pembayaran gateway, payout, UI.
- Migrasi (hanya bila parkir jurnal butuh kolom/tabel baru): nomor 0610 saja. Pakai mekanisme parkir/retry jurnal yang sudah ada bila ada.

## Pembagian paralel (giliran pertama)
- Explore (2): (a) titik split refund ke gateway_clearing dan sumber data payment_refunds; (b) mekanisme parkir/retry jurnal otomatis yang sudah ada (auto-journal gaps, ws/auto-journal-gaps di batch64a).
- test-writer: test gagal-dulu: (1) refund split tanpa baris payment_refunds tapi payment_intent_id ada -> akun benar; (2) tidak bisa dipastikan -> jurnal diparkir, tidak ke gateway_clearing; (3) retry tidak menggandakan jurnal; (4) total debit = kredit dan jumlah refund tidak melebihi pembayaran.
- implementer: satu.
- Pemegang token heavy: satu subagent.

## Bukti selesai
- `LEGEND_TEST_FILES="<file test>" heavy pnpm test` hijau, merah di base tercatat.
- Pra-gate AGENTS.md (prettier, eslint, typecheck api lewat heavy; migrasi: `pnpm db:generate` kosong dan `node ~/.agents/team/check-journal.mjs origin/milestone/m1`).

## Batas kerja ulang
- Typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua, sekali lagi; gagal ketiga lapor.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Keputusan aturan uang yang ragu: pilih yang membatasi pembayaran dan tanyakan CTO.

## Sebelum melapor
Commit hanya file scope, rename cabang ke `fix/refund-split-journal-fallback`, push tanpa force. Jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, cabang akhir, test gagal-dulu, check-journal (bila migrasi), risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
