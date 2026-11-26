# Protokol jembatan EDC v1 dan token perangkat (B1, legend-wasr7.20)

Dasar: `docs/design/edc-auto-cloud.md`. Kontrak kode: `packages/shared/src/edc/bridge.ts` (`@starter/shared/edc/bridge`), test `apps/api/src/test/edc-bridge-contract.test.ts`.

## Prinsip

- Jembatan = pipa. Adapter bank di cloud menyusun isi pesan ECR (base64) dan membaca jawaban terminal. Jembatan hanya membungkus (STX, panjang BCD, ETX, LRC, ACK/NAK maks 3 kirim ulang) dan mengirim balik jawaban mentah. Jembatan tidak pernah tahu nominal atau memutuskan `approved`.
- Aturan uang tetap di agent cloud E1-E7 (`apps/api/src/edge/edc/agent.ts`): tulis-dulu, idempotensi, inquiry sebelum ulang, cek nominal, PAN disamarkan.
- Satu pesan JSON per frame teks WSS, maks 16 KB, diperiksa sebelum `JSON.parse`. Semua skema `strictObject`: field asing ditolak, socket ditutup.

## Alur

1. Tablet membuka WSS ke `/api/edc-bridge` dengan `Authorization: Bearer <token>` (B2). Token tidak pernah ada di URL atau di isi pesan.
2. Jembatan -> `hello` {protocolVersion, appVersion, unackedResults}. Versi tidak didukung: cloud -> `goodbye protocol_unsupported`, tutup.
3. Cloud -> `lease` {grants, refused}: daftar lengkap terminal yang dipegang tablet ini. Grant = terminalId, leaseId, expiresAt, link (LAN IPv4 privat + port, atau USB + baud), framing. Satu EDC satu tablet: lease per terminal dipegang di cloud; terminal yang dipegang tablet lain -> `held_by_other_device`. Cloud memperbarui dengan `lease` baru sebelum `expiresAt`.
4. Jembatan mengirim ulang semua hasil di jurnal yang belum di-ack.
5. Cloud -> `command` {commandId, leaseId, terminalId, op sale|cancel|inquiry|void, trace, frame, timeoutMs}. Cloud menandai `dispatched` tepat sebelum mengirim.
6. Jembatan -> `result` {commandId, terminalId, op, trace, replayOf, completedAt, answer}. `answer` = `response` (frame mentah) | `transport_error` (timeout, disconnected, protocol) | `refused` (lease_invalid, terminal_busy, link_down, duplicate_in_flight).
7. Cloud menyimpan hasil, lalu -> `ack` {commandId}. Baru sesudah ack jembatan menghapus dari jurnal.

## Pengaman

- Hasil hilang: jurnal Room ditulis sebelum dikirim, dikirim ulang tiap sambung ulang sampai ack. Hasil yang datang terlambat dicocokkan cloud lewat terminalId + trace (jendela `EDC_LATE_RESPONSE_WINDOW_MS`).
- Ragu = `unknown`: selain `response`, semua jawaban menjadi `EcrTransportError` (`edcBridgeTransportErrorOf`), termasuk `refused`. Agent lalu inquiry, tidak pernah `failed`.
- Perintah ganda: `sale` dan `void` dijalankan maks sekali per terminal + trace (`edcBridgeDedupeKey`). Perintah kedua: hasil pertama diputar ulang dengan `replayOf`; bila masih berjalan, `refused duplicate_in_flight`. `cancel` dan `inquiry` lewat (tidak menagih).
- Lease kedaluwarsa atau bukan milik tablet: tidak ada perintah baru yang dimulai; yang sedang berjalan diselesaikan dan dijurnal.
- Link LAN hanya ke IPv4 privat RFC 1918, jadi perintah cloud tidak bisa memakai tablet sebagai proxy TCP ke internet atau ke dirinya sendiri. Bluetooth tidak dilayani jembatan (`connection_unsupported`).
- Hasil hanya membawa frame mentah, tanpa PAN hasil decode. Penyamaran PAN tetap di skema hasil cloud (`ecrResultDetailsSchema`).

## Token perangkat (per tablet)

- Format: `edcb_<ULID perangkat>_<32 byte acak base64url>` (`edcBridgeDeviceTokenSchema`). Cloud hanya menyimpan SHA-256 token, dibandingkan waktu-konstan.
- Tabel `edc_bridge_devices` (migrasi B2): id (ULID), tenant_id, outlet_id, label, token_hash, created_by, created_at, last_seen_at, revoked_at. Penugasan terminal ke perangkat di cloud; lease hanya untuk terminal di outlet perangkat itu.
- Pemasangan: admin dengan izin pembayaran outlet membuat kode 8 karakter Crockford (`edcBridgePairingCodeSchema`), berlaku 10 menit, sekali pakai, ditolak setelah 5 kali salah. Tablet menukar kode dengan token lewat HTTPS; token hanya tampil sekali dan disimpan di Android Keystore (EncryptedSharedPreferences).
- Cabut: `revoked_at` diisi -> socket aktif mendapat `goodbye token_revoked`, lease dilepas, perintah pending di cloud menjadi `unknown` lewat aturan biasa. Ganti tablet = pasang ulang (token baru), tidak ada pemakaian token bersama.
- Satu sesi per perangkat: sambungan baru dengan token sama menutup yang lama (`goodbye replaced_by_newer_session`).
- Token, kode pasang, dan isi frame tidak pernah dicatat di log (redaksi pino).

## Versi

- `EDC_BRIDGE_PROTOCOL_VERSION = 1`. Menambah nilai enum framing atau alasan baru yang aman diabaikan: tetap v1, cloud dan aplikasi dirilis bersama. Mengubah arti field atau aturan jurnal/dedupe: versi baru, cloud mendukung versi lama sampai semua tablet diperbarui.

## Belum diputuskan (B2/B5)

- Framing persis per bank menunggu dokumen ECR bank (B0/B5); `stx_bcdlen_etx_lrc` adalah bentuk umum dan bisa ditambah.
- Lama lease dan interval perpanjangan ditetapkan di B2.
