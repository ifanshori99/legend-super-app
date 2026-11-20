# SO edge 1199 P2 fix (1208, 20 Nov, architect, int/batch100)
Verdict: TIDAK (1 P2 uang)
## P2 Promo tetap aktif dari rewind sampai halaman pertama stream promotions commit
`apps/api/src/edge/catalog-puller.ts:272-279,844-857,1202,1233-1268`, `apps/api/src/edge/promo-gate-runtime.ts:44-82`. Marker `catalog:replay:promotions` baru dibuat saat halaman promotions pertama tiba. Sebelumnya: watermark 'rewind' membiarkan `last_success_at` segar, `unfinished` hanya cek epoch, gate promo hanya cek umur. (1) restart edge sesudah rewind: stream 1-11 di-replay dulu, promo hilang di cloud tetap diskon. (2) cloud sengaja tak terjangkau (`docs/deployment.md:176`): pull gagal transport, pending mark dihapus `:1268`, promo aktif sampai 24 jam.
Usulan: gate promo membaca watermark `catalog:promotions` + marker replay (false bila REWIND_MARK atau marker ada); `:276` REWIND_MARK = unfinished untuk stream promo; SQL rewind di deployment.md set `last_success_at='epoch'` untuk promotions + vouchers; test rewind+transport gagal dan selama replay stream sebelumnya.
Tertutup: P2-A (`edge-catalog-apply.ts:602-605`, 0288), P2-B replayOpen epoch benar, promotions bukan stream kritis, override tutup benar (`catalog-gate.ts:286-306`).
Belum: link event apply saat replay menulis sync_txid nol? (fail-closed bila ya), `runtime.ts:1000-1180`, restamp-list vs tabel edge-only selain edge_voucher_catalog.
## Keputusan CTO: perbaiki semua langkah 1-4 (kartu 1212). Sama dengan keputusan P2-B: fail closed.
