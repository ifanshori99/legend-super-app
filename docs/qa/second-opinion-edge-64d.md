# Second opinion edge — batch 64d (#778)

Tanggal: 14 November 2026. Peran: second-opinion, read-only pada kode.

## Target dan metode

- Snapshot: `origin/int/batch64d` = `9b8433f691f1d34533e9728ddf49f697112e174b`, sama dengan HEAD worktree saat audit.
- Merge transport: `951a8d22b`, membawa `3c4b17f17` (`fix/edge-transport-no-outlet`).
- Merge alarm: `3c00b17cf`, membawa `e37338e6d` dan `a97e18c46` (`fix/edge-dead-letter-alarm-cost`).
- Katalog: `packages/shared/src/events/catalog.ts`, dibandingkan dengan kedua parent merge dan tip batch.
- Pemeriksaan statis oleh tiga subagent paralel (puncak tiga), kemudian verifikasi silang sumber dan skenario oleh agent utama. Tidak menjalankan test, heavy, build, layanan, atau perubahan kode; satu-satunya berkas keluaran adalah laporan ini.

## Temuan

P0: 0. P1: 0. P2: 1. P3: 0.

- `apps/api/src/services/core-outbox-dead-alert.ts:108` — **P2: Alarm yang gagal dapat tidak pernah dicoba ulang saat blocked head baru terus datang.** Halaman hanya kembali ke awal ketika hasil setelah cursor kosong; cursor maju sebelum pengiriman alarm dan tetap maju ketika pengiriman gagal. Skenario: alarm A gagal sekali; notifier pulih; sebelum setiap sweep berikutnya, muncul satu blocked head B, C, D, dan seterusnya dengan ID lebih besar daripada cursor. Setiap halaman selalu berisi, sehingga A tetap berada di belakang cursor tanpa marker notifikasi dan tidak pernah memperoleh alarm. Saran: beri jatah retry untuk head lama atau paksa kembali ke awal dalam batas jumlah sweep/waktu, sambil mempertahankan batas batch dan deduplikasi.

### Bukti dan usul test P2

- Filter cursor memakai `o.id > afterId` pada `core-outbox-dead-alert.ts:55`; seleksi berurutan dibatasi 100 pada baris 58.
- Fallback ke halaman pertama hanya terjadi jika halaman setelah cursor kosong pada baris 108–109.
- Cursor disimpan dari head terakhir sebelum loop notifikasi pada baris 119; exception satu head hanya dicatat pada baris 182–183. Marker yang gagal ditulis tidak ikut commit, tetapi head tersebut tetap terlewati oleh cursor.
- Tidak perlu lebih dari 100 head baru per sweep. Satu head baru ber-ID lebih besar sudah cukup mempertahankan halaman nonkosong. Contoh: sweep 1 memilih A dan gagal; sweep 2 memilih B dan berhasil; sweep 3 memilih C dan berhasil. A tidak dipilih lagi selama pola itu berlanjut.
- Test yang ada di `apps/api/src/test/edge-event-class.test.ts:817` memulai 101 head, menggagalkan 100 pertama, lalu memulihkan notifier. Test itu membuktikan retry setelah tail kosong, belum menguji tail yang terus bertambah.
- Usul test regresi: gagalkan notifikasi A sekali, pulihkan notifier, tambahkan satu blocked aggregate baru dengan ID meningkat sebelum setiap sweep, lalu buktikan A menerima tepat satu alarm dalam batas sweep yang ditetapkan. Pastikan tidak ada alarm ganda untuk head yang sudah berhasil. Test ini belum ditulis atau dijalankan.

## Hasil pemeriksaan lain

- **Outlet kosong atau berbeda:** tidak ditemukan jalur penerimaan atau overwrite lintas outlet pada cakupan. Transport menolak outlet kosong sebelum enqueue (`apps/api/src/worker/transport.ts:96`); enqueue membandingkan outlet event dengan node (`apps/api/src/services/edge-queue.service.ts:129`); penerimaan menolak tenant/outlet berbeda termasuk outlet null (`apps/api/src/edge/db-link-store.ts:516`). Offset juga menolak perubahan outlet (`apps/api/src/services/core-outbox.ts:396`). Parking berlangsung setelah transaksi delivery batal (`core-outbox.ts:419`), sehingga konsumsi dan offset tidak ikut maju.
- **Deduplikasi dan biaya alarm:** identitas alarm mencakup tenant, destination, aggregate, sequence, dan generation; advisory lock serta pemeriksaan marker berada dalam transaksi (`core-outbox-dead-alert.ts:130`, `:145`). Sweep memilih maksimal 100 head dan melewati marker yang sudah tersimpan sebelum lookup penerima. Reachability email dan WhatsApp dipasang false (`apps/api/src/services/edge-sync-conflict-alert.ts:242`); tidak ditemukan jalur pengiriman email/WhatsApp berbayar dari alarm ini. Temuan P2 di atas menyangkut retry yang tertunda, bukan pengiriman ganda.
- **Katalog tidak kehilangan event:** perbandingan statis Python atas pasangan nama/workstream menunjukkan parent pertama 241 event, parent kedua 240, hasil merge 242, tanpa duplikat atau event parent yang hilang/berpindah workstream. Katalog merge identik dengan tip batch. `edge_link.dead_lettered` dan `edge_outbox.blocked` sama-sama dipertahankan di baris 40; `reservation.rescheduled` tetap ada di baris 52. Pembentuk version dan payloadSchemaRef tidak berubah.

## Batas perilaku dan verifikasi

- Alarm dan gauge ini khusus dead head yang menahan event berikutnya, sesuai predicate `EXISTS later` pada `core-outbox-dead-alert.ts:68`. Dead event tunggal/tail tanpa penerus tidak masuk gauge atau alarm ini. Ini dicatat sebagai batas cakupan, bukan temuan tambahan tanpa invariant bahwa setiap dead row wajib memicu alarm.
- Ketika tidak ada penerima, jalur blocked-outbox menyimpan marker kosong dan menulis `logger.error` sekali (`core-outbox-dead-alert.ts:169`, `:173`; `edge-sync-conflict-alert.ts:180`). Penambahan supervisor kemudian tidak memicu ulang alarm yang sama. Perilaku ini disengaja pada test sumber `edge-event-class.test.ts:847`; belum diverifikasi melalui eksekusi.
- Tidak menjalankan test terarah maupun gate penuh. Kesimpulan dan P2 berasal dari alur sumber, bukan reproduksi database. Tidak ada klaim bahwa test/build lulus atau seluruh sistem edge telah aman.
- Usul tambahan test isolasi: kirim event inbound dengan outlet null lalu outlet B ke node A; pastikan transaksi ditolak, cursor tidak maju, dan data outlet A/B tidak berubah. Usul katalog: pertahankan assertion tiga event di atas beserta workstream dan payloadSchemaRef.
