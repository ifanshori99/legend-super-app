# Second opinion kas laci, tutup shift, dan refund — 862

Tanggal: 15 November 2026. Review read-only terhadap kode; perubahan berkas hanya laporan dan catatan progres.

Hasil diff: **P0: 0, P1: 0, P2: 1, P3: 0.** Tidak ditemukan skenario konkret pembayaran ganda, pembayaran melebihi sisa bayar, atau kasir memutuskan kas keluarnya sendiri pada perubahan yang ditinjau. Ini hasil pemeriksaan statis, bukan bukti test runtime.

## Rentang yang diperiksa

Base semua diff: `milestone/m1` pada `b42619abce5d326d547c4ae17293adca970db99e`.

| Area                                                  | Cabang                           | Commit yang diperiksa                      |
| ----------------------------------------------------- | -------------------------------- | ------------------------------------------ |
| 841: approval kas keluar, agregat shift, jurnal       | `ws/cash-out-approval`           | `049d5e65c49ef3cd484b2a4cb861f9c8ce1b4334` |
| 856: kas fisik refund/void, recount, 403 approver     | `ghostex/0c60597d`               | `c31f83405d7c904959a014a61594fb3195924d85` |
| 850: refile refund sistem, follow-up, struk terlambat | `ghostex/alarm-ops-refund-struk` | `55fdd1936a11a66fd7c5bcc1712374ea9b27e764` |

Bagian 841 yang juga ada pada 856 diperiksa sekali. Tiga subagent read-only berjalan bersamaan, puncak tiga; temuan dan rujukan kode diperiksa kembali oleh agent utama. Cabang sumber tidak digabung atau diubah.

## Temuan

- **P2 — `apps/api/src/services/pos-shift.service.ts:866` (856): Kredit hitung ulang memakai waktu permintaan keputusan sebelum kunci shift; count yang sebenarnya mendahului keputusan dapat tetap memakan jatah.** Skenario: count ketiga sudah memegang kunci shift tetapi masih menunggu pemeriksaan izin/replay; permintaan keputusan supervisor menyimpan `now`; count lalu menyimpan `submittedAt` yang lebih baru sebelum keputusan memperoleh kunci. Keputusan membuat count basi melalui watermark, tetapi syarat `decidedAt > submittedAt` tidak mengkreditkannya. Kasir hanya mendapat dua hitung ulang baru, dan hitung ulang ketiga ditolak `SHIFT_COUNT_LIMIT`, meskipun ketiga count lama dibuat sebelum keputusan diterapkan. Perbaikan: tentukan batas count yang dikreditkan berdasarkan urutan di bawah kunci shift, misalnya sequence count terakhir saat keputusan atau versi keputusan monoton; jangan mengandalkan perbandingan jam permintaan. Memindahkan `now` sesudah kunci menghilangkan inversi antrean, tetapi timestamp dalam milidetik yang sama juga harus ditangani tanpa mengkreditkan count sesudah keputusan.

Rujukan bukti:

- [`pos-shift-cash-approval.service.ts:76`](https://github.com/ifanshori99/legend-super-app/blob/c31f83405d7c904959a014a61594fb3195924d85/apps/api/src/services/pos-shift-cash-approval.service.ts#L76): `now` diambil sebelum transaksi dan sebelum kunci shift pada baris 105.
- [`pos-shift.service.ts:788`](https://github.com/ifanshori99/legend-super-app/blob/c31f83405d7c904959a014a61594fb3195924d85/apps/api/src/services/pos-shift.service.ts#L788): count mengunci shift, lalu masih menunggu izin dan replay sebelum mengambil `now` pada baris 819; nilai ini disimpan sebagai `submittedAt` pada baris 889.
- [`pos-shift.service.ts:866`](https://github.com/ifanshori99/legend-super-app/blob/c31f83405d7c904959a014a61594fb3195924d85/apps/api/src/services/pos-shift.service.ts#L866): penentu kredit menggunakan waktu, sedangkan penentu basi pada baris 1332–1336 menggunakan watermark.

Test regresi yang diperlukan: tahan count ketiga sesudah memperoleh kunci tetapi sebelum mengambil waktunya; mulai keputusan supervisor dan biarkan mengambil waktu; lanjutkan count dan keputusan. Count lama harus basi, ketiga recount baru harus diterima, recount keempat harus ditolak. Ulangi untuk approve/reject dan timestamp yang sama; pastikan variance kekurangan tetap tersimpan dan tidak ada uang tambahan keluar. Test recount yang tersedia pada `pos-shift-recount-quota-856.test.ts:488–556` menggunakan urutan count lalu keputusan, sehingga tidak menguji interleaving ini.

## Invariant yang diperiksa tanpa temuan baru

- Persetujuan kas keluar memfilter tenant/outlet/shift, melarang pencatat memutuskan sendiri pada service dan trigger, mengunci shift, serta membatasi approval berdasarkan kas fisik setelah held refund/void dikurangi.
- Agregat shift memasukkan kas keluar approved sekali melalui `EXISTS`; outcome ikut watermark; keputusan tidak mengubah shift yang sudah ditutup. Event recorded/approved memakai kunci jurnal yang sama.
- Refund/void dan pencatatan kas keluar pada 856 mengurangi held correction cash dari batas drawer; keputusan refund melalui endpoint refund menolak approver terakhir tanpa supervisor sebelum menulis keputusan.
- Refile pada 850 menghitung `cap - reserved`, menggunakan kunci berdasarkan refund gagal, dan membatasi retry refund sistem. Penolakan dan provider decline pada refund sistem menuju follow-up. Jalur kegagalan yang ditelusuri memegang kunci intent.
- Follow-up membatasi tenant/outlet dan izin baca; kedatangan struk memegang kunci urutan yang sama dengan write-off serta memakai savepoint notifikasi.

## Catatan bawaan base, di luar hitungan temuan diff

- Guard 403 baru pada endpoint refund belum ada pada endpoint inbox umum: `apps/api/src/services/platform-approval.service.ts:1489–1502` di 856 tetap dapat menyimpan approval Finance yang sesuai matriks tetapi tanpa `pos.refund.approve`; settlement pada `payment-refund.service.ts:1222` kemudian menggagalkan refund dengan `approver_unauthorized`. Perilaku endpoint alternatif ini sudah ada pada base. Bila syarat 403/no-write dimaksudkan berlaku untuk semua pintu approval, terapkan preflight yang sama di service keputusan umum dan tambahkan test melalui `/api/approvals/:requestId/decisions`.
- Gate alasan refile QR pada `apps/api/src/services/payment-refund.service.ts:718` di 850 hanya berlaku bagi `system:qr`. Refund manual pada pembayaran QR terlambat yang ditolak masih dapat memicu pengganti `system:qr`; hubungan dengan pembuat refund manual tidak dibaca oleh `isPosRefundParty`. Jalur ini sudah ada pada base (`payment-refund.service.ts:700–748`, serta pengecualian requester pada baris 343). Audit asal pihak refund dan kebijakan refile manual perlu dilakukan terpisah; ini tidak diklaim sebagai regresi 850 atau bukti pembayaran ganda.

## Verifikasi dan batas

- Membaca diff, jalur transaksi/kunci, permission, idempotensi, trigger migrasi, dan test terkait pada commit yang dicatat di atas; rujukan temuan diperiksa kembali terhadap isi commit.
- Tidak menjalankan test aplikasi, typecheck, build, atau browser; tidak menyalakan layanan dan tidak mengubah kode maupun data aplikasi. Skenario P2 dibuktikan dari urutan kode, belum direproduksi dengan test konkurensi PostgreSQL.
- Tidak memvalidasi hasil merge ketiga cabang. Test gabungan tetap perlu dijalankan pada rantai integrasi setelah perbaikan.
- Pemeriksaan dokumen menggunakan `git diff --check` dan Prettier 3.9.6 melalui `pnpm dlx`; binary Prettier/ESLint pada worktree tidak tersedia. Format laporan diperiksa, sedangkan `docs/PROGRESS.md` sudah tidak sesuai Prettier pada `HEAD` sebelum catatan ini ditambahkan; format bagian lama tidak diubah. ESLint tidak berhasil dijalankan karena dependensi tidak tersedia.
