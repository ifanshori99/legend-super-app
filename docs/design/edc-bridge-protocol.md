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
- Pemasangan (B4 legend-wasr7.24, migrasi 0543): `POST /api/edc-bridge/devices` (dan "terbitkan kode baru" `POST /api/edc-bridge/devices/:id/pair-code`) menjawab kode pasang 8 karakter (`edcBridgePairingCodeSchema`, alfabet A-Z dan 2-9 tanpa 0/O/1/I/L, acak kripto), berlaku 10 menit, sekali pakai, `Cache-Control: no-store`; tidak pernah token. Satu kode hidup per perangkat: kode baru membatalkan yang lama. Tabel `edc_bridge_pair_codes` menyimpan 4 karakter pertama (`code_selector`) dan HMAC-SHA-256 berkunci dari seluruh kode (`code_hash`), tidak pernah kode mentah; RLS tenant + outlet, tanpa DELETE.
- Penukaran: tablet memanggil `POST /api/edc-bridge/pair` dengan `{ code, deviceFingerprint? }` (strict; `deviceFingerprint` diterima, belum disimpan). Sukses: kode ditandai terpakai dan token perangkat baru (`edcb_<ULID perangkat>_...`, hash di `edc_bridge_devices.token_hash`) diterbitkan dalam satu transaksi dengan kunci baris perangkat lalu kode, jadi dua penukaran bersamaan hanya satu yang berhasil. Token terikat ke perangkat pemilik kode. Tablet lama dengan token yang diganti mendapat `goodbye token_revoked`. Gagal (salah, kedaluwarsa, terpakai, dibatalkan, terkunci, perangkat dicabut): selalu 400 `EDC_PAIR_CODE_INVALID` yang sama.
- Batas: 5 kode salah per kode (`EDC_BRIDGE_PAIRING_MAX_ATTEMPTS`; kode salah dengan selector kode hidup menambah `failed_attempts` kode itu, pada 5 kode terkunci walau benar) dan 5 per IP per 15 menit (429 `RATE_LIMITED` + `Retry-After`). Hitungan IP ada di database (`edc_bridge_pair_ip_slots`, digest IP berkunci, tanpa tenant, hanya lewat fungsi SECURITY DEFINER), jadi tidak hilang saat restart dan sama di semua instance; slot dikembalikan bila kode benar.
- Kenapa `/pair` tanpa `requireAuth`/`requireTrustedOrigin`: tablet adalah aplikasi Android, bukan browser, jadi tidak punya sesi cookie atau Origin; kode itulah kredensialnya dan tanpa cookie tidak ada yang bisa ditumpangi permintaan lintas situs. Tetap `jsonBody` (batas 100 kB, hanya JSON) dan skema strict.
- Tablet menyimpan token di Android Keystore (AES-GCM, `DeviceSettings`); token hanya tampil sekali di jawaban `/pair`. Token tersimpan hanya dipakai untuk server yang sama; alamat server berubah = wajib kode pasang baru (token tidak pernah dikirim ke host lain).
- Pasang ulang di instance API mana pun: sesi socket menyimpan hash token saat autentikasi, dan perpanjangan lease (tiap 30 s) mensyaratkan hash itu masih milik perangkat. Token diganti = `goodbye token_revoked` paling lambat di perpanjangan berikut; di instance yang sama langsung.
- Cabut: `revoked_at` diisi -> socket aktif mendapat `goodbye token_revoked`, lease dilepas, perintah pending di cloud menjadi `unknown` lewat aturan biasa. Ganti tablet = pasang ulang (token baru), tidak ada pemakaian token bersama.
- Satu sesi per perangkat: sambungan baru dengan token sama menutup yang lama (`goodbye replaced_by_newer_session`).
- Token, kode pasang, dan isi frame tidak pernah dicatat di log (redaksi pino).

## Versi

- `EDC_BRIDGE_PROTOCOL_VERSION = 1`. Menambah nilai enum framing atau alasan baru yang aman diabaikan: tetap v1, cloud dan aplikasi dirilis bersama. Mengubah arti field atau aturan jurnal/dedupe: versi baru, cloud mendukung versi lama sampai semua tablet diperbarui.

## Cloud (B2, legend-wasr7.21)

- `apps/api/src/edge/edc/cloud-runtime.ts`: satu agent per proses API (`EDC_BRIDGE_ENABLED`, bukan EDGE_MODE). Outlet diambil saat tablet pertama outlet itu `hello` (`agent.start`, advisory lock). Proses tanpa lock tidak memberi lease, jadi tidak pernah mengirim perintah; kasir di sana mendapat `EDC_AGENT_NOT_READY`. Tidak ada penerusan ke proses lain.
- Lease: tabel `edc_bridge_terminal_leases` (jam cloud), `ttlMs` 120 s, diperpanjang tiap 30 s. Terminal pindah tablet hanya lewat `INSERT .. ON CONFLICT .. WHERE issued_at + ttl + 330 s <= sekarang`. Lease hanya untuk terminal `connection_kind = 'bridge'` yang ditugaskan ke perangkat itu (`payment_edc_terminals.bridge_device_id`, FK tenant+outlet+perangkat).
- Perintah disimpan di memori sampai hasil atau tenggat (`timeoutMs` + 30 s) dan di `edc_bridge_commands` (tanpa frame). Hasil di luar memori (terlambat atau sesudah restart) dicocokkan di tenant + outlet + perangkat + terminal, disimpan, di-ack; baris ledger diselesaikan lewat inquiry.
- Tidak terkirim sama sekali (sesi/lease hilang sebelum ditulis): `sale` -> `failed` "tidak pernah dikirim" (`edcNotSentError`); sesudah ditulis: selalu `unknown`.
- `sale_record_release`: sesudah impor settlement X2 dan pada tiap `hello`, untuk sale perangkat itu yang barisnya `matched`; `release_sent_at` dicatat. Catatan (review P3-5, tidak diubah): `release_sent_at` dicatat saat pesan masuk buffer socket, bukan saat tablet menerima; pesan yang hilang tidak dikirim ulang. Akibatnya hanya catatan sale tertahan lebih lama di tablet; batas simpan 30 hari tetap berlaku, uang tidak terpengaruh.
- Hasil disimpan dengan `result_evidence` (outcome, nominal, kode approval, RRN, kode respons, jenis kartu, invoice, batch, trace; tanpa PAN dan teks terminal). Ack hanya sesudah hasil tersimpan; tulis perintah/hasil dicoba ulang 3x, lalu log `alert: edc_cloud_result_persist_failed` tanpa ack (tablet mengirim ulang, idempoten).
- Impor settlement CSV BRI ditolak `EDC_SETTLEMENT_FORMAT_UNVERIFIED` sampai ada contoh file asli dari bank.
- Manajemen perangkat: `/api/edc-bridge/devices` (daftar, buat dengan kode pasang, terbitkan kode baru, cabut, tugaskan terminal), izin `payment.edc.manage`. Penukaran kode: `/api/edc-bridge/pair` (B4, lihat "Token perangkat"). UI backoffice: legend-osqou.19.
- Kunci outlet hilang (keputusan CTO): proses API tidak pernah dimatikan, hanya outlet itu yang berhenti. Socket jembatan outlet itu mendapat `goodbye server_shutdown` dan ditutup (tablet menyambung ulang), lease-nya lepas dari memori, perintah yang sudah terkirim tetap menunggu tenggat lalu `unknown` (hasil yang datang sesudahnya disimpan dan di-ack sebagai hasil terlambat, tidak menyelesaikan ledger; inquiry agent berikut yang menyelesaikan). Permintaan baru outlet itu `EDC_AGENT_NOT_READY` sampai kunci diambil lagi (coba ulang 1 s berlipat sampai 30 s). Outlet lain tetap jalan. Baris lease di DB tetap, jadi tablet lain tidak mengambil terminal sebelum waktu serah. Log `alert: edc_cloud_outlet_lock_lost` untuk ops. Jalur edge tetap keluar proses (fail-stop).

## Provider cloud

Registry cloud (`CloudEdcProviderRegistry`) memilih provider per terminal dari `payment_edc_terminals.connection_kind`:

- `bridge`: `EdcBridgeProvider` = codec bank (`EdcBridgeCodec`, `bridge-codec.ts`: `encodeSale`/`encodeTrace` sinkron, `decodeResult`/`decodeInquiry` melempar `EcrTransportError("protocol")` bila tak terbaca) + transport WSS. Production belum punya codec (B5), jadi semua terminal ditolak `connection_unsupported`.
- `bca_cloud` (B5a, legend-wasr7.23): isi `CloudEdcRuntimeOptions.bcaCloud` dengan `EdcProvider & { ready(terminal): boolean }`. Aturan yang harus dipenuhi: `ready` false = `EDC_AGENT_NOT_READY` sebelum baris ledger ada; `sale` menulis request HTTPS di tick yang sama dan, bila tidak ada yang terkirim, menolak dengan `edcNotSentError()`; `202IS00`, `504IS00`, timeout, dan error jaringan sesudah request terkirim = `EcrTransportError` (agent mencatat `unknown`, lalu inquiry `inquiry-status`), tidak pernah `failed`; `X-EXTERNAL-ID` baru tiap request, `partnerReferenceNo` = trace agent (tetap per percobaan bayar); nominal hanya dari `request.amountIdr`.
- Kunci outlet `bca_cloud`: tidak ada tablet yang `hello`, jadi provider wajib punya `outlets()` (outlet dengan terminal `bca_cloud` aktif). `startOutlets()` dipanggil saat boot (server.ts) dan mengambil kunci tiap outlet itu (gagal: coba ulang dengan backoff). Outlet yang ditambah sesudah boot diambil lazily lewat `prepareSale` sebelum sale dan sebelum opsi bayar (`prepareEdcAgent` di resolver), hanya bila outlet itu punya terminal `bca_cloud` aktif (opsi bayar memakai daftar terminal yang sudah dimuat, sale membaca satu baris; B5a, catatan review B2). `ensureOutlet(tenantId, outletId)` publik dan idempoten; tanpa provider cloud, `prepareSale` tidak melakukan apa-apa (outlet jembatan menunggu tablet).

## Provider bca_cloud (B5a, legend-wasr7.23)

`apps/api/src/edge/edc/bca-cloud-provider.ts` + `bca-snap-client.ts`. Server memanggil gateway BCA (API ECR cloud), tanpa tablet. Aturan uang tetap di agent (E1-E7).

- Konfigurasi: `EDC_BCA_CLOUD_BASE_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_PRIVATE_KEY_PATH`, `_PARTNER_ID`, `_CHANNEL_ID` di api.env (semua atau tidak sama sekali; https di luar development/test; file kunci harus kunci privat RSA yang terbaca). Tanpa kredensial provider tidak dipasang: terminal `bca_cloud` = `EDC_AGENT_NOT_READY` -> EDC manual X1. Butuh juga `EDC_BRIDGE_ENABLED=true` (runtime agent cloud).
- Token: OAuth2 client_credentials (`/openapi/v1.0/access-token/b2b`, tanda tangan RSA SHA-256 atas `clientId|timestamp`), disimpan sampai kedaluwarsa - 60 s. `prepareSale` mengambil token sebelum sale dan opsi bayar; `ready` = token tersimpan, jadi tanpa token terminal tidak siap sebelum baris ledger ada. Token yang ditolak BCA (401) dibuang dan diambil ulang.
- Transaksi: header `Authorization`, `X-TIMESTAMP`, `X-SIGNATURE` (HMAC-SHA512 dengan client secret atas `POST:path:token:sha256(body):timestamp`), `X-PARTNER-ID`, `X-EXTERNAL-ID` (32 digit, baru tiap request), `CHANNEL-ID`, `ORIGIN` (origin API sampai BCA menentukan lain).
- Sale `POST /openapi/v1.0/ecr/payment`: `partnerReferenceNo` = trace agent (tetap per percobaan bayar), nominal `amount.value` dari tagihan server. Request ditulis di tick yang sama; tanpa token tidak ada yang dikirim (`edcNotSentError`, `failed` "tidak pernah dikirim").
- Sesudah terkirim, ragu = `unknown` lalu inquiry, tidak pernah `failed`: `202IS00`, `504IS00`, timeout, error jaringan/putus, 5xx, respons tak terbaca, respons untuk referensi lain. `409IS00` = bug (external id ulang): `unknown` + log `alert: edc_bca_cloud_external_id_reused`. Hanya 4xx sebelum diproses (400, 401, 403, 404, 429, status HTTP dan kode respons sama) = `declined` dengan kode BCA sebagai bukti.
- Inquiry `POST /openapi/v1.0/ecr/inquiry-status` (`originalPartnerReferenceNo` = trace). `not_found` tanpa batch: agent membiarkan sale yang sudah dikirim `unknown` + rekonsiliasi X2.
- Void: endpoint payment, `transType` 08, `partnerReferenceNo` `V<trace>` (tetap, aman diulang), `cancelled` hanya bila BCA sukses. Cancel saat menunggu kartu tidak ada (`cancelInProgress` false), selalu `EcrTransportError`.
- Kolom hasil dipilih satu per satu dan diparse `ecrResultSchema` (tanpa PAN, tanpa teks bebas BCA). Log hanya terminal, trace, status HTTP, kode BCA: tanpa token, secret, signature, PAN, body.
- Bridge (catatan review B2): `evidence()` mem-parse ulang keluaran codec dengan `ecrResultSchema`/`ecrInquiryResultSchema` sebelum disimpan.
- **Belum diverifikasi bank**: format tanda tangan, path token, nama field body, nilai `transType`/`partnerType`, kode status (`00`/`03`/`05`/`06`/`07`) mengikuti standar SNAP dan ringkasan publik, bukan dokumen ECR BCA. Semua ditandai `BCA-DOC` di kode dan dikunci test vektor (`src/test/edc-bca-cloud.test.ts` b5a-1). Ganti begitu dokumen BCA diterima (B0), lalu uji UAT di terminal asli.
- Test: stub `src/test/helpers/bca-ecr-stub.ts` (approved, declined, ditolak 400, 202 lalu inquiry approved, 504 lalu not found, putus sesudah kirim, 409, token kedaluwarsa).

## Belum diputuskan (B2/B5)

- Framing persis per bank menunggu dokumen ECR bank (B0/B5); `stx_bcdlen_etx_lrc` adalah bentuk umum dan bisa ditambah.
- Nilai `ttlMs` (120 s) dan interval perpanjangan (30 s) ditetapkan di B2.
