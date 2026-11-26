# Protokol jembatan EDC v1 dan token perangkat (B1, legend-wasr7.20)

Dasar: `docs/design/edc-auto-cloud.md`. Kontrak kode: `packages/shared/src/edc/bridge.ts` (`@starter/shared/edc/bridge`), test `apps/api/src/test/edc-bridge-contract.test.ts`.

## Prinsip

- Jembatan = pipa. Adapter bank di cloud menyusun isi pesan ECR (base64) dan membaca jawaban terminal. Jembatan hanya membungkus (STX, panjang BCD, ETX, LRC, ACK/NAK maks 3 kirim ulang) dan mengirim balik jawaban mentah. Jembatan tidak pernah tahu nominal atau memutuskan `approved`.
- Aturan uang tetap di agent cloud E1-E7 (`apps/api/src/edge/edc/agent.ts`): tulis-dulu, idempotensi, inquiry sebelum ulang, cek nominal, PAN disamarkan.
- Satu pesan JSON per frame teks WSS, maks 16 KB, diperiksa sebelum `JSON.parse`. Semua skema `strictObject`: field asing ditolak, socket ditutup.

## Alur

1. Tablet membuka WSS ke `/api/edc-bridge` dengan `Authorization: Bearer <token>` (B2). Token tidak pernah ada di URL atau di isi pesan.
2. Jembatan -> `hello` {protocolVersion, appVersion, unackedResults, heldSaleRecords}. `heldSaleRecords` = catatan sale lewat 48 jam yang masih tertahan karena belum ada release; cloud memantau angka ini. Versi tidak didukung: cloud -> `goodbye protocol_unsupported`, tutup.
3. Cloud -> `lease` {grants, refused}: daftar lengkap terminal yang dipegang tablet ini. Grant = terminalId, leaseId, `ttlMs` (10 s-10 menit), link (LAN IPv4 privat + port, atau USB + baud), framing. Satu EDC satu tablet: lease per terminal dipegang di cloud; terminal yang dipegang tablet lain -> `held_by_other_device`. Cloud memperbarui dengan `lease` baru sebelum ttl habis.
4. Cloud -> `sale_record_release` {terminalId, traces[1-500]} sesudah settlement batch terminal itu tercocok. Trace yang tidak dikenal diabaikan.
5. Jembatan mengirim ulang semua hasil di jurnal yang belum di-ack.
6. Cloud -> `command` {commandId, leaseId, terminalId, op sale|cancel|inquiry|void, trace, frame, timeoutMs}. Cloud menandai `dispatched` tepat sebelum mengirim.
7. Jembatan -> `result` {commandId, terminalId, op, trace, replayOf, completedAt, answer}. `answer` = `response` (frame mentah) | `transport_error` (timeout, disconnected, protocol) | `refused` (lease_invalid, terminal_busy, link_down, duplicate_in_flight, trace_conflict).
8. Cloud menyimpan hasil, lalu -> `ack` {commandId}. Baru sesudah ack jembatan menghapus hasil itu dari antrean unacked. Catatan dedupe sale tidak ikut terhapus (lihat Pengaman).

## Pengaman

- Hasil hilang: antrean unacked (Room) ditulis sebelum dikirim, dikirim ulang tiap sambung ulang sampai ack.
- Cloud menerima `result` hanya bila `commandId` pernah dikirim ke deviceId sesi itu dan terminalId, op, trace, dan replayOf sama dengan perintah yang disimpan cloud; selain itu dibuang dan dicatat. Hasil terlambat (jendela `EDC_LATE_RESPONSE_WINDOW_MS`) dicocokkan hanya dalam tenant + outlet + terminal perangkat itu, tidak pernah lintas outlet. Test wajib di B2 (legend-wasr7.21).
- Ragu = `unknown`: selain `response`, semua jawaban menjadi `EcrTransportError` (`edcBridgeTransportErrorOf`), termasuk `refused`. Agent lalu inquiry, tidak pernah `failed`.
- Perintah ganda: hanya `sale` di-dedupe, per terminal + trace (`edcBridgeDedupeKey`, `edcBridgeDedupeDecision`). `void`, `cancel`, dan `inquiry` selalu ke terminal (void yang gagal di jalur harus benar-benar diulang, bukan diputar ulang).
- Catatan dedupe sale terpisah dari antrean unacked: {commandId, SHA-256 frame (`edcBridgeFrameSha256`, dari teks base64 apa adanya), state, answer (`null` selama berjalan), storedAt, released}. Ack tidak menghapusnya. Dihapus bila (umur >= 48 jam DAN sudah menerima `sale_record_release`) ATAU umur >= 30 hari, batas keras penyimpanan (`edcBridgeSaleRecordDeletable`). Catatan `done` tanpa answer diperlakukan seperti masih berjalan (`duplicate_in_flight`).
- Sale kedua dengan trace sama: hash frame sama dan selesai -> hasil pertama diputar ulang dengan `replayOf`; hash sama dan masih berjalan -> `refused duplicate_in_flight`; hash beda -> `refused trace_conflict` (cloud: `unknown`). Jawaban "approved" lama tidak pernah dipakai untuk sale lain, walau trace terminal berputar.
- Lease: tablet menghitung `ttlMs` dengan jam monotonik sejak pesan `lease` diterima, tidak pernah membandingkan dengan jam cloud. Habis atau bukan milik tablet: tidak ada perintah baru yang dimulai; yang sedang berjalan diselesaikan dan dijurnal.
- `issuedAt` = saat cloud mengirim grant atau perpanjangan terakhir untuk terminal itu (jam cloud). Cloud tidak mengirim perintah bila sisa lease (`issuedAt + ttlMs - sekarang`) kurang dari 30 s (`edcBridgeLeaseAllowsCommand`).
- Cloud tidak memberi lease terminal itu ke tablet lain sebelum `issuedAt + ttlMs + 300 s (timeout maks) + 30 s` menurut jam cloud (`edcBridgeLeaseReusableAt`), jadi jam tablet yang mundur atau lease yang pindah tidak pernah membuat dua tablet bicara ke satu EDC.
- Link LAN hanya ke IPv4 privat RFC 1918 (bukan 0.0.0.0, loopback, link-local, CGNAT 100.64/10), jadi perintah cloud tidak bisa memakai tablet sebagai proxy TCP ke internet. Link ke alamat interface tablet sendiri ditolak di jembatan (`edcBridgeLinkTargetsSelf`): semua perintah di lease itu dijawab `refused lease_invalid`. Bluetooth tidak dilayani jembatan (`connection_unsupported`).
- Hasil hanya membawa frame mentah, tanpa PAN hasil decode. Penyamaran PAN tetap di skema hasil cloud (`ecrResultDetailsSchema`).

## Token perangkat (per tablet)

- Format: `edcb_<ULID perangkat>_<32 byte acak base64url>` (`edcBridgeDeviceTokenSchema`). Cloud hanya menyimpan SHA-256 token, dibandingkan waktu-konstan.
- Tabel `edc_bridge_devices` (migrasi B2): id (ULID), tenant_id, outlet_id, label, token_hash, created_by, created_at, last_seen_at, revoked_at. Penugasan terminal ke perangkat di cloud; lease hanya untuk terminal di outlet perangkat itu.
- Pemasangan: admin dengan izin pembayaran outlet membuat kode 8 karakter Crockford (`edcBridgePairingCodeSchema`), berlaku 10 menit, sekali pakai. Maks 5 kali salah (`EDC_BRIDGE_PAIRING_MAX_ATTEMPTS`) per kode, dan juga per IP sumber dan per perangkat dalam jendela yang sama; sesudahnya kode hangus dan IP/perangkat diblokir sementara. Tablet menukar kode dengan token lewat HTTPS; token hanya tampil sekali dan disimpan di Android Keystore (EncryptedSharedPreferences).
- Cabut: `revoked_at` diisi -> socket aktif mendapat `goodbye token_revoked`, lease dilepas, perintah pending di cloud menjadi `unknown` lewat aturan biasa. Ganti tablet = pasang ulang (token baru), tidak ada pemakaian token bersama.
- Satu sesi per perangkat: sambungan baru dengan token sama menutup yang lama (`goodbye replaced_by_newer_session`).
- Token, kode pasang, dan isi frame tidak pernah dicatat di log (redaksi pino).

## Versi

- `EDC_BRIDGE_PROTOCOL_VERSION = 1`. Menambah nilai enum framing atau alasan baru yang aman diabaikan: tetap v1, cloud dan aplikasi dirilis bersama. Mengubah arti field atau aturan jurnal/dedupe: versi baru, cloud mendukung versi lama sampai semua tablet diperbarui.

## Belum diputuskan (B2/B5)

- Framing persis per bank menunggu dokumen ECR bank (B0/B5); `stx_bcdlen_etx_lrc` adalah bentuk umum dan bisa ditambah.
- Nilai `ttlMs` dan interval perpanjangan ditetapkan di B2 (dalam batas 10 s-10 menit).
