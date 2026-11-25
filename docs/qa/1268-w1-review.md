# Review W1 layar pesan kasir (ws/1268-w1 ebb78f606+, 26 Nov): TIDAK LULUS, 1 P1, 4 P2

Berkas di `apps/web/src/features/ws04-pos-order/`.

1. **P1 parkir yang dilanjutkan bisa hilang** (`api.ts` resumeDraft, `order-flow.ts` resumeParked): server sudah mengonsumsi snapshot, `endIntent` jalan, lalu `fetchCatalog` gagal atau refresh. Fix: katalog diambil SEBELUM resume; baris hasil ditulis ke draft SEBELUM `endIntent`; intent resume yang belum jelas diselesaikan (replay kunci sama) saat layar dibuka.
2. **P2 parkir ganda** (`api.ts` parkDraft): `Promise.all` park + fetchCatalog. Fix: park tidak bergantung katalog; kegagalan katalog tidak menggagalkan park.
3. **P2 buntu ORDER_INTENT_PENDING** (`order-flow.ts:44-52,88,105`, `intent-store.ts`): `meta` (meja, kanal, ref ojol) ikut sidik jari tapi tidak disimpan; `IDEMPOTENCY_KEY_REUSED` tidak pernah menghapus intent. Keputusan CTO: simpan isi + meta asli di intent; tampilkan aksi "Kembalikan pesanan tertunda" yang memulihkan isi+meta persis lalu mengirim ulang kunci sama (tidak pernah membuat kunci baru diam-diam). Penolakan final server (4xx selain 401/408/409 in-progress/429) = intent selesai, keranjang tetap. KEY_REUSED = intent ditutup hanya setelah kasir mengonfirmasi sudah memeriksa pesanan terbuka. Pesan menyebut meja dan kanal.
4. **P2 tes lama rusak** (`tests/ws04-pos-order-mock-engine.test.mjs:212-333,634-729`): input masih `tableLabel`. Perbarui input (`tableSessionId`, `variants: []`), asersi tidak berubah; jalankan.
5. **P2 modifier hilang diam-diam** (`order-wire.ts` mapParked): opsi yang tak ada di katalog harus dihitung `missing`, barisnya tidak dipulihkan diam-diam.
6. **P3** `hooks.ts:72` `actorId` kosong: tolak kirim. P3 draf lama dibuang: diterima. P3 katalog per kanal: kartu.

Belum dicek reviewer: tab duplikat (sessionStorage tersalin), ganti outlet/perangkat/akun di tengah intent, `apps/web/test/pos-936-*`.
