# Decisions

Technical decisions the PRD leaves open. Newest first. Each entry names its
bead so the code comments and tests can be traced back.

## 2026-11-10: Bukti PIN sekali pakai untuk absen outlet_device di edge (legend-u7g9w, dari review legend-j6cyb, membuka legend-tvkuz)

Konteks: di cabang `ws/j6cyb-edge-attendance`, `POST /api/hris/attendance/clock`
dengan method `outlet_device` memakai `requireAuth` dan `actor(req)`: staf yang
tercatat absen adalah pemilik sesi Better Auth di layar itu, bukan orang yang
mengetik PIN. `POST /api/staff-pins/verify` memeriksa PIN (lockout 5 kali salah,
kunci 15 menit per staf per outlet) tetapi hanya mengembalikan
`{user, outletId, verifiedAt}`: tidak ada token, tidak ada sesi, pergantian
pengguna di layar bersama hanya di sisi klien. Founder Q86: absen di layar
outlet = PIN + selfie. Tingkat K (auth).

Opsi:

1. Bukti PIN berumur pendek, sekali pakai, terikat device + staf + tujuan.
2. Sesi PIN per absen: PIN membuat sesi Better Auth sementara, absen, lalu
   sign-out. Ditolak: sesi itu punya kuasa penuh staf di layar bersama; bila
   sign-out gagal, orang berikutnya bertindak atas nama staf itu (kelas bug yang
   sama). Peran `mfa_required` juga butuh TOTP di kios. `sign-in` di edge tidak
   pernah berhasil (desain HRIS edge §12), jadi tabel sesi edge harus ditulis
   jalur baru.
3. PIN dikirim langsung di body absen. Ditolak: layar menyapa staf sebelum
   selfie, jadi PIN harus disimpan di memori browser selama kamera aktif atau
   diperiksa dua kali (dua kali menyentuh hitungan lockout), dan unggahan selfie
   tidak terikat ke orang yang sudah terverifikasi.

Keputusan: opsi 1, token opak di database edge (bukan JWT bertanda tangan).

- Terbit: `POST /api/staff-pins/verify` dengan body tambahan opsional
  `purpose: "attendance_clock"`. Bila PIN benar, respons menambah
  `proof: { token, expiresAt }`. Tanpa `purpose` respons tetap seperti sekarang
  (pergantian kasir POS tidak berubah).
- Bentuk: 32 byte acak, base64url, prefix `pp_`. Database hanya menyimpan
  sha256-nya (`staff_pin_proofs.token_hash`). Tidak butuh kunci tanda tangan,
  jadi tidak menambah rahasia di edge dan tidak memakai pepper PIN.
- TTL 120 detik: cukup untuk selfie dan unggah di jaringan outlet yang lambat.
- Replay: bukti dikonsumsi sekali dengan
  `UPDATE ... SET consumed_at = now() WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() AND device_id = $2 RETURNING user_id`
  di transaksi yang sama dengan insert log absen. Bukti terikat ke device dari
  `X-Device-Token` saat terbit: bukti dari device lain ditolak. Terbit bukti
  baru untuk device yang sama langsung mengakhiri bukti lama yang belum dipakai
  (satu bukti hidup per device, tidak bisa ditimbun). Layar outlet melayani satu
  orang sekali jalan: bila staf B mulai saat alur staf A belum selesai, alur A
  batal dan layar meminta A mulai lagi dari PIN. PIN benar tidak menambah
  hitungan lockout, jadi A tidak dirugikan.
- Ulang karena jaringan: route absen mencari bukti lewat `token_hash` dan
  `device_id` dulu, terpakai atau belum, untuk mendapat `user_id`. Lalu route
  mencari log dengan `idempotencyKey` milik staf itu dari device itu. Bila ada:
  200 dengan log lama. Bila tidak: bukti dikonsumsi seperti biasa. Ulang hanya
  bisa dilakukan oleh pemegang token bukti itu sendiri, jadi log staf lain tidak
  pernah terbuka.
- Rate limit: lockout per staf yang ada tetap (5 salah, 15 menit). Tambahan per
  device, berlaku untuk semua `/api/staff-pins/verify`: 10 PIN salah dalam satu
  jendela tetap 5 menit (dimulai dari salah pertama) lintas staf memberi 429
  `PIN_DEVICE_THROTTLED` dengan `Retry-After` sampai jendela habis. Ini menahan
  tebak-sebar (4 tebakan ke banyak staf supaya tidak kena lockout). Throttle
  hanya mengenai device itu sendiri: tiap kasir POS dan layar outlet punya
  device token sendiri, jadi perangkat lain di outlet tetap jalan. Yang bisa
  memicunya hanya pemegang device token itu, yaitu orang yang sudah memegang
  perangkatnya. Saat throttle aktif: satu audit `staff_pin.device_throttled` dan
  satu notifikasi ke manajer outlet per jendela, supaya serangan yang terus
  memperbarui jendela terlihat dan token device bisa dicabut. Penghitung di
  tabel `device_pin_throttle`, bukan memori, supaya tahan restart. Permintaan
  yang ditolak throttle tidak menambah `failed_attempts` staf.
- Izin: route `outlet-clock` sengaja tidak memakai `requireBackOfficeSurface`
  (aturan `MFA_REQUIRED` milik sesi, dan bukti bukan sesi). Route memeriksa
  sendiri bahwa staf pemilik bukti adalah karyawan aktif dengan izin
  `self.attendance.clock` di outlet device itu (`loadHrisAccess`). Pemeriksaan
  yang sama berjalan saat bukti diterbitkan dengan
  `purpose: "attendance_clock"`, sebelum PIN dicek (403 `ATTENDANCE_NOT_ALLOWED`).
  Jadi kasir yang bukan karyawan HRIS tidak bisa membuat bukti, dan tidak ada
  sinyal "PIN benar" untuk orang yang tidak boleh absen. Jawaban 403 ini memang
  membuka siapa yang boleh absen, tetapi daftar nama di layar outlet sudah hanya
  berisi staf yang boleh absen, jadi tidak ada informasi baru.
- MFA: staf peran `mfa_required` (manajer, pemilik) bisa absen di layar outlet
  dengan PIN + selfie tanpa TOTP. Alasan bisnis: absen hanya mencatat kehadiran
  diri sendiri, bukan akses ke data atau uang. Selfie dan tanda cek supervisor
  (Q87) adalah pengamannya. Bukti hanya berlaku di route `outlet-clock` dan
  unggah selfie, tidak pernah menjadi sesi, dan ditolak di route lain mana pun.
- Route: absen lewat layar outlet pindah ke route baru
  `POST /api/hris/attendance/outlet-clock` (masuk `EDGE_API_EXACT_ROUTES`),
  tanpa sesi. Header `X-Device-Token` + `X-Pin-Proof`, body
  `{ type, occurredAt, photoUploadRef, idempotencyKey }`, tanpa `userId`: staf
  diambil dari bukti. `POST /api/hris/attendance/clock` dengan method
  `outlet_device` menjadi 400 `ATTENDANCE_METHOD_USE_OUTLET_CLOCK`. Satu route
  dengan dua cara auth mudah salah, jadi keduanya dipisah.
- Selfie: `POST /api/storage/uploads` untuk selfie absen menerima
  `X-Device-Token` + `X-Pin-Proof` tanpa sesi. Bukti dicek dengan syarat yang
  sama seperti konsumsi (belum terpakai, belum kedaluwarsa atau diakhiri bukti
  baru, device sama), tetapi tidak dikonsumsi. Bukti yang sudah habis tidak bisa
  lagi dipakai mengunggah. Server mengisi `core_storage_objects.owner_user_id` dari
  `proof.user_id` (tidak pernah dari klien) dan kolom baru `pin_proof_id`.
  Pemeriksaan selfie yang ada (`ownerUserId === staf`,
  `hris-attendance.service.ts:884` di j6cyb) tetap berlaku dengan staf dari
  bukti. `outlet-clock` juga menolak selfie yang `pin_proof_id`-nya bukan bukti
  ini (400 `SELFIE_NOT_FROM_PROOF`), jadi selfie orang lain tidak bisa ditempel.
- CORS: `app.ts` `allowedHeaders` ditambah `X-Device-Token` dan `X-Pin-Proof`.
  Header ini sudah dipakai (`routes/device-id.ts`, `device-pin.routes.ts`, route
  clock), tetapi preflight lintas origin gagal hari ini. Kios tidak mengirim
  cookie, jadi bukti di header tidak terkena CSRF.
- Alur layar (legend-tvkuz): pilih nama, ketik PIN, terima bukti, ambil selfie,
  unggah dengan bukti, absen dengan bukti, layar bersih. Tidak ada sesi yang
  perlu di-sign-out.

Kontrak dan migrasi: migrasi 0241 membuat `staff_pin_proofs` (id, tenant_id,
outlet_id, device_id, user_id, purpose CHECK `attendance_clock`, token_hash
UNIQUE, expires_at, consumed_at, created_at, RLS tenant + outlet) dan
`device_pin_throttle` (tenant_id, device_id PK, window_started_at, failures),
dan menambah `core_storage_objects.pin_proof_id` (nullable, FK ke
`staff_pin_proofs`, ON DELETE SET NULL). Baris bukti lebih tua dari 1 hari
dihapus job housekeeping edge. Kontrak baru di
`packages/shared/src/hris/endpoints.ts`: route outlet-clock, `purpose` dan
`proof` di verify, kode error `PIN_PROOF_INVALID` (401: tidak dikenal,
kedaluwarsa, device lain), `PIN_PROOF_USED` (409), `PIN_DEVICE_THROTTLED` (429),
`ATTENDANCE_NOT_ALLOWED` (403), `SELFIE_NOT_FROM_PROOF` (400),
`ATTENDANCE_METHOD_USE_OUTLET_CLOCK` (400). Payload
`attendance.logged` tidak berubah: setelah perubahan ini method `outlet_device`
selalu berarti PIN sudah diperiksa. Produk belum production, jadi tidak ada log
`outlet_device` lama yang perlu dibedakan.

Risiko: lalu lintas LAN ke edge membawa PIN dan bukti, jadi harus HTTPS atau
dalam satu perangkat. Device token yang dicuri bersama bukti dari kios yang sama
berarti kios itu sendiri sudah dikuasai: batasnya satu outlet, dan tiap absen
tetap butuh selfie.

Rencana cadangan: bila tabel bukti di edge bermasalah, ganti dengan HMAC
bertanda tangan kunci node edge (klaim sama, `jti` disimpan untuk sekali pakai).
Kontrak HTTP tidak berubah.

Kartu: legend-u7g9w (basis `ws/j6cyb-edge-attendance`, tingkat K, migrasi 0241).
legend-tvkuz sekarang bergantung padanya. Bersentuhan dengan legend-jmsdx di
`device-pin.service.ts`: kartu ini tidak mengubah fungsi verify. Bukti dan
throttle ada di service baru `staff-pin-proof.service.ts`.

## 2026-11-10: Pepper PIN per outlet di edge, rotasi, dan hash lama (legend-ideif, lanjutan legend-jmsdx)

Konteks: cabang `ws/ideif-edge-pepper` (1cc10ce4, belum merge) sudah menutup
temuan utama: edge menolak boot bila root `STAFF_PIN_PEPPER` ada, dan menerima
pepper turunan tenant yang tersegel di `edge_staff_pin_peppers` (migrasi 0225,
AES-256-GCM dengan kunci dari kredensial node). Turunan sekarang
`HKDF-SHA256(root, salt "legend", info "legend:staff-pin-pepper:v{n}:{tenant}")`,
hanya per tenant. Hash PIN: `scrypt(HMAC-SHA256(pepper, "legend:staff-pin:v1\0tenant\0outlet\0user\0pin"))`,
dan baris `staff_pins` sudah per (tenant, outlet, staf). Tingkat K.

Masalah tersisa: edge outlet A yang dicuri membawa pepper seluruh tenant.
Ditambah satu kebocoran salinan `staff_pins` cloud, hash PIN semua outlet tenant
itu bisa ditebak offline. Rotasi darurat juga harus menyentuh semua outlet.

Opsi:

1. Tetap per tenant. Ditolak: radius bocor satu tenant penuh.
2. Per outlet lewat versi pepper baru. Dipilih.
3. Membungkus hash lama dengan pepper baru tanpa PIN asli. Ditolak: verifikasi
   tetap butuh pepper lama di edge, jadi tidak ada keamanan yang bertambah.

Keputusan:

- Versi pepper 2 dan seterusnya diturunkan per outlet:
  `info "legend:staff-pin-pepper:v{n}:{tenant}:{outlet}"`. Versi 1 tetap per
  tenant dan hanya untuk cloud. Default `STAFF_PIN_PEPPER_CURRENT_VERSION`
  menjadi 2.
- Edge hanya menerima pepper outletnya sendiri: versi 2 ke atas yang dipakai
  baris `staff_pins` outlet itu, ditambah versi current. Edge tidak pernah
  menerima versi 1. AAD segel menjadi `tenant:outlet:version`. Primary key
  `edge_staff_pin_peppers` (tenant, edge_node, version) tetap, karena satu node
  = satu outlet.
- Protokol sync pepper berubah. Sekarang edge melapor `peppers=<n>` (versi
  1..n lengkap, `edgeStaffPinPepperContiguous`) dan cloud mengirim dari n+1.
  Tanpa versi 1, n akan selalu 0. Gantinya: edge mengirim daftar versi yang
  dipegang (`peppers=2,3`), dan cloud mengirim selisihnya dari himpunan {versi
  dipakai baris outlet itu} ∪ {current}, tanpa versi 1.
- PIN yang di-set di edge (jalur `setStaffPin` edge yang sudah ada, diadopsi
  cloud lewat kunci `pin_generation_at` yang lebih baru) memakai pepper outlet
  versi current. Cloud menurunkan pepper yang sama dari root, jadi hash itu
  tetap bisa diverifikasi di cloud.
- Keputusan bukti PIN (legend-u7g9w) memakai verifikasi lokal ini apa adanya.
  Bukti tidak memakai pepper dan tidak butuh kunci baru.
- Rotasi terencana: naikkan `STAFF_PIN_PEPPER_CURRENT_VERSION` di env cloud,
  lalu deploy. PIN baru dan PIN yang diganti memakai versi baru. Baris lama
  tetap terverifikasi dengan versinya sendiri, di cloud maupun di edge, tanpa
  batas waktu. Karena pepper per outlet, versi lama outlet B tidak ikut lemah
  saat outlet A bocor, jadi versi lama tidak perlu dipensiunkan paksa dan
  outlet yang hanya memakai edge tidak pernah dipaksa reset oleh rotasi biasa.
- Rehash: verify yang berhasil di cloud pada baris berversi lama di-rehash di
  transaksi `FOR UPDATE` yang sama (cloud memegang PIN asli di request itu).
  Rehash mempertahankan `pin_generation_at` dan `pin_set_at` apa adanya. Edge
  menerapkan bahan hash baru karena kuncinya sama (aturan
  `record key >= local key`). PIN yang lebih baru di edge (kunci lebih besar)
  tetap menang, dan cloud mengadopsinya seperti biasa. Edge tidak rehash: agar
  diadopsi cloud, edge harus memberi kunci generasi baru, dan kunci baru itu
  bisa mengalahkan reset PIN dari cloud yang belum sampai ke edge, sehingga PIN
  lama hidup lagi.
- Baris versi 1 yang ditemui edge: 409 `STAFF_PIN_RESET_REQUIRED` ("PIN perlu
  diatur ulang"). Respons ini tidak menambah `failed_attempts`. Ini hanya
  mengenai data dev dan staging. Production dimulai di versi 2, sehingga tidak
  ada baris versi 1 di sana.
- Edge dicuri (runbook baru `docs/runbooks/edge-node-stolen.md`): cabut node dan
  semua token device outlet itu, naikkan versi current, lalu reset PIN semua staf
  outlet itu, termasuk baris staf yang sama di outlet lain, karena PIN yang sama
  sering dipakai ulang. PIN baru outlet itu memakai versi baru, sehingga pepper
  curian tidak berguna lagi. Pepper outlet lain tidak perlu dirotasi, karena
  pepper curian hanya cocok untuk hash outlet itu. Reset di outlet lain hanya
  untuk staf yang sama, karena PIN-nya mungkin dipakai ulang.

Kontrak dan migrasi: tanpa migrasi skema. Produk belum production
(`docs/PROGRESS.md`), jadi tidak ada hash PIN asli berversi 1. Seed dev dan test
pindah ke versi 2. Data staging berversi 1 ter-rehash saat verify berikutnya di
cloud, atau direset. Nomor 0243 dicadangkan bila ternyata perlu CHECK. Kontrak
HTTP: query `peppers` di `GET /api/edge-sync/staff-pin-records` menjadi daftar
versi, dan kode error baru `STAFF_PIN_RESET_REQUIRED` (409). Edge dan cloud
dirilis bersama (belum production), jadi tidak butuh jalur kompat untuk
`peppers=<n>` lama.

Risiko: PIN 6 digit di edge yang dicuri tetap bisa ditebak offline untuk staf
outlet itu (10^6 percobaan scrypt). Ini bawaan semua verifikasi offline, dan
karena itu runbook mewajibkan reset PIN. Kunci segel berasal dari kredensial
node yang juga ada di edge, jadi segel hanya melindungi salinan database (backup),
bukan disk yang dicuri utuh. Root `STAFF_PIN_PEPPER` yang bocor dari cloud
membuka semua versi sekaligus. Menaikkan versi tidak menolong, karena turunannya
dari root yang sama. Jalurnya: root baru dan reset semua PIN. Pemetaan versi ke
root baru belum dibangun, karena ini kejadian luar biasa.

Rencana cadangan: bila staf sering pindah outlet dan reset per outlet terasa
berat, kembalikan cakupan versi berikutnya ke tenant. Ini satu baris di fungsi
turunan, karena versi lama tetap bisa diverifikasi.

Kartu: legend-jmsdx (basis `ws/ideif-edge-pepper`, tingkat K, tanpa migrasi).
Bersentuhan dengan legend-u7g9w hanya di `device-pin.service.ts`: kartu ini
menambah rehash di verify cloud.

## 2026-11-10: Laporan pajak: pembetulan sebagai rantai revisi (legend-4uapw, legend-r3i8w, dasar legend-5nhkp)

Konteks: `tax_reports` (cabang `ws/gmww-accounting-deltas`, migrasi 0235
sementara) hanya unik untuk draft (`tax_reports_draft_key`). Setelah periode
dibuka ulang dan laporan difinalkan lagi, dua laporan final/exported hidup
berdampingan tanpa tanda mana yang berlaku, dan XML Coretax lama bisa diekspor
ulang. Trigger `app.guard_tax_report_filed` mengunci baris setelah draft, dan
komentarnya menyebut koreksi = draft baru setelah periode dibuka ulang.
Pertanyaan kartu: unik keras (supersede) atau banyak versi (pembetulan SPT)?

Fakta hukum: UU KUP Pasal 8 dan Coretax mengizinkan pembetulan berkali-kali
selama belum diperiksa. Coretax memberi kode 0 untuk SPT normal dan 1, 2, dan
seterusnya untuk pembetulan, dan tiap pembetulan menggantikan SPT sebelumnya
secara utuh. Jadi keduanya benar sekaligus: banyak versi per periode memang sah,
tetapi pada satu waktu hanya satu yang berlaku.

Opsi:

1. Unik keras satu laporan final per periode. Ditolak: pembetulan tidak bisa
   dicatat, dan riwayat laporan yang sudah dikirim hilang.
2. Bebas banyak final tanpa penanda. Ditolak: ini bug yang sekarang.
3. Rantai revisi. Dipilih: tiap final baru menggantikan final sebelumnya,
   bernomor, dan yang lama tetap tersimpan baca-saja.

Keputusan:

- Kolom baru:
  - `revision_no smallint`: NULL saat draft, 0 = normal, n = pembetulan ke-n.
  - `supersedes_id`, `superseded_by_id`: FK komposit ke (tenant_id, id).
  - `superseded_at`.
  - `correction_reason text`: wajib untuk revisi 1 ke atas, NULL untuk revisi 0.
  - `fiscal_period_version int NOT NULL`: versi periode saat draft dibuat atau
    dibuat ulang, untuk audit "revisi ini berdasarkan buku versi berapa".
- CHECK di database (selain yang sudah ada seperti `tax_reports_finalized_check`):
  - `(status = 'draft') = (revision_no IS NULL)` dan `revision_no >= 0`.
  - `revision_no IS NULL OR (revision_no = 0) = (supersedes_id IS NULL)`.
  - `revision_no IS NULL OR (revision_no >= 1) = (correction_reason IS NOT NULL)`,
    dan `correction_reason IS NULL OR length(btrim(correction_reason)) > 0`.
  - `(superseded_at IS NULL) = (superseded_by_id IS NULL)`.
  - `superseded_by_id IS NULL OR superseded_by_id <> id`.
- Dua index unik parsial:
  - (tenant, entitas, jenis, periode, revision_no) `WHERE status <> 'draft'`.
  - (tenant, entitas, jenis, periode)
    `WHERE status <> 'draft' AND superseded_at IS NULL`: tepat satu laporan
    berlaku.
  - Index draft tetap.
- Generate draft (upsert pada `tax_reports_draft_key`) mencatat
  `fiscal_period_version` dari periode saat itu.
- Finalize dalam satu transaksi:
  1. Kunci draft `FOR UPDATE`.
  2. Kunci periode `FOR SHARE`, supaya reopen yang berjalan bersamaan harus
     menunggu. Periode harus tutup, dan `period.version` harus sama dengan
     `draft.fiscal_period_version`. Bila beda, 409 `TAX_REPORT_STALE`: buat
     ulang draft. Tutup periode menaikkan versi, jadi draft yang dibuat saat
     periode masih buka selalu harus dibuat ulang dari buku yang sudah tutup.
     Kunci ini hanya bertahan selama transaksi finalize yang pendek. Urutan
     kunci selalu draft, periode, laporan berlaku. Tutup dan buka periode tidak
     menyentuh `tax_reports`, jadi tidak ada deadlock.
  3. `SELECT ... FOR UPDATE` laporan berlaku untuk kunci itu.
  4. `revision_no` = nomor revisi lama + 1, atau 0 bila belum ada.
     `correction_reason` wajib bila nomor itu 1 ke atas (400
     `TAX_REPORT_CORRECTION_REASON_REQUIRED`).
  5. Isi `superseded_at` dan `superseded_by_id` pada yang lama dan naikkan
     `version`-nya, lalu ubah draft menjadi final. Urutan ini menjaga index
     "satu berlaku" tidak bentrok, dan index tetap menjadi pengaman bila dua
     finalize balapan (409).
- Trigger `app.guard_tax_report_filed` diperluas:
  - Setelah draft, kolom `revision_no`, `supersedes_id`, `correction_reason` dan
    `fiscal_period_version` tidak boleh berubah, sama seperti kolom yang sudah
    dikunci.
  - Kolom supersede (`superseded_at` + `superseded_by_id`) diisi bersama, satu
    kali, dari NULL. Setelah itu tidak bisa diubah atau dikosongkan.
  - Baris yang sudah superseded menolak semua perubahan lain, termasuk final
    menjadi exported. Ekspor pada laporan berlaku tetap jalan seperti sekarang.
  - `file_key` dikunci setelah terisi.
- Constraint trigger `DEFERRABLE INITIALLY DEFERRED` memeriksa rantai saat
  commit. Pengganti (`superseded_by_id`) harus berkunci sama (tenant, entitas,
  jenis, periode), non-draft, dengan `supersedes_id` = baris lama dan
  `revision_no` = lama + 1. Jadi tidak ada periode yang tertinggal tanpa
  laporan berlaku karena bug service.
- Ekspor: kunci baris `FOR UPDATE`, lalu cek ulang `superseded_at`. Laporan
  superseded memberi 409 `TAX_REPORT_SUPERSEDED` dengan `supersededById`, bukan
  error trigger mentah. Ekspor ulang revisi berlaku mengembalikan berkas yang
  sama (`file_key` terkunci, dan isinya ditentukan baris yang juga terkunci).
  Berkas XML revisi lama tetap bisa diunduh lewat `file_key`-nya untuk audit,
  diberi label "diganti oleh revisi n", tetapi tidak pernah dibuat ulang.
- Daftar: `GET /tax-reports` mengembalikan laporan berlaku dan draft.
  `?includeSuperseded=true` menampilkan riwayat. Tiap baris membawa
  `revisionNo`, `isCurrent`, `supersededById`.
- Label di layar: revisi 0 "Normal", revisi n "Pembetulan ke-n". Nomor ini
  urutan internal Legend. Coretax memberi nomornya sendiri saat pembetulan dibuat
  di sana, jadi keduanya bisa berbeda bila sebuah revisi Legend tidak pernah
  dilaporkan.

Kontrak dan migrasi: kolom, CHECK, index dan trigger dilipat ke migrasi
`0235_tax_reports` di cabang `ws/gmww-accounting-deltas` selama cabang itu belum
merge. Nomornya masih sementara, belum pernah jalan di lingkungan bersama, dan FK
bisa ditulis inline (pola `contracts.md` 1). Komentar trigger di 0235 yang
menyebut ekspor ulang membuat berkas baru ikut diperbarui. Bila 0235 sudah merge
saat kartu dikerjakan, pakai migrasi 0242. Migrasi itu harus berhenti dengan
error bila `tax_reports` berisi baris apa pun, termasuk draft: tidak ada
backfill, trigger akan memblokir backfill, dan `fiscal_period_version NOT NULL`
tidak bisa ditambah ke baris yang ada. FK ditambah `NOT VALID` lalu `VALIDATE`.
Perubahan di
`packages/shared/src/accounting/tax.ts`:

- Field baru di `TaxReport`, dan `superRefine` ikut CHECK di atas.
- `transitionTaxReport` menerima `Pick<TaxReport, "status" | "supersededAt">`
  dan menolak ekspor laporan superseded.
- `coretaxExportFileName(type, period, revisionNo: number)`: hanya dipanggil
  untuk baris non-draft, jadi `revisionNo` tidak pernah null.
- Finalize body `{ correctionReason? }`.
- Kode error `TAX_REPORT_SUPERSEDED` (409), `TAX_REPORT_STALE` (409) dan
  `TAX_REPORT_CORRECTION_REASON_REQUIRED` (400).

legend-5nhkp membangun service dan route di atas skema ini.

Risiko: label "Pembetulan ke-n" bisa berbeda dari nomor di Coretax bila ada
revisi yang difinalkan tetapi tidak pernah diunggah. Mitigasi nanti: penanda
"sudah dilaporkan" (tanggal + nomor BPE) per laporan. Ini keputusan alur kerja
akuntan, bukan syarat skema ini.

Rencana cadangan: bila akuntan ingin pembetulan hanya dihitung dari laporan yang
sudah dilaporkan, tambahkan `filed_at` dan hitung label dari baris yang punya
`filed_at`. Rantai supersede tidak berubah.

Kartu: legend-r3i8w (basis `ws/gmww-accounting-deltas`, tingkat K karena
migrasi, lipat ke 0235, cadangan 0242). legend-5nhkp sekarang bergantung padanya.

## 2026-11-10: Laporan harian tanpa pesanan latihan (legend-fbxzw)

Konteks: rekap akhir hari (`computeRecap`, `pos-day.service.ts`) masih
menjumlahkan pesanan latihan, tidak sejalan dengan kas shift (legend-0v3b3) dan
laporan WS-11. Tingkat S.

Keputusan: rekap mengecualikan pesanan latihan dari SEMUA bagiannya (himpunan
penjualan, tender captured per metode, void, refund) lewat `reportablePosOrders()`.
Bila hanya tender yang dikecualikan, pemeriksaan keseimbangan (tender sama
dengan total penjualan) melempar CONFLICT, jadi keempatnya harus sama.
Lanjutan (keputusan CTO, Q63: latihan tidak boleh memengaruhi operasi nyata):

1. **Pesanan latihan yang menggantung tidak menahan tutup hari.** Pemeriksaan
   "masih ada pesanan yang belum selesai" di `closePosDay` memakai
   `reportablePosOrders()`. Pesanan nyata yang belum selesai tetap menahan.
2. **Bagian shift dan kas rekap tidak difilter latihan, dengan bukti.** Shift
   khusus latihan memang bisa ada: `pos_shifts` tidak punya penanda latihan
   (`db/schema/pos-shift.ts:49-75`), buka shift tidak memeriksa mode latihan
   (`pos-shift.service.ts:161-249`), dan `setDeviceTrainingMode`
   (`device.service.ts:507-556`) tidak melihat shift terbuka, jadi mode bisa
   dialihkan di tengah shift dan satu shift berisi pesanan nyata dan latihan
   (`pos_orders.shift_id` tidak dicek terhadap `is_training`,
   `pos-order.service.ts:719-744`). `cash_movements` (`pos-shift.ts:341-375`)
   tidak punya penanda latihan dan tidak punya `device_id`. Baris shift, selisih,
   dan kas kedaluwarsa adalah keadaan laci uang sungguhan: kasir menghitung dan
   memindahkan uang fisik. Selisih itu sudah dihitung tanpa tunai latihan
   (legend-0v3b3) dan dijurnal saat tutup shift
   (`cashier_shift.closed`). Menyembunyikan shift dari rekap akan membuat rekap
   tidak sejalan dengan buku besar dan bisa menyembunyikan kas nyata pada shift
   campuran, jadi bagian ini dibiarkan. Bila founder ingin shift latihan murni
   disembunyikan, perlu penanda latihan pada `pos_shifts` (migrasi) lebih dulu.

## 2026-11-10: Pesanan latihan: kas shift dan stok (legend-0v3b3, legend-13avp)

Konteks: lanjutan legend-gkc6b. Review architect menemukan tutup shift masih
menghitung tender tunai pesanan latihan ke kas yang diharapkan, dan founder
(Q63) memutuskan pesanan latihan tidak memotong stok. Tingkat K (uang).

1. **Kas shift (legend-0v3b3).** `computeShiftAggregates` mengecualikan tender
   tunai, refund tunai, dan void tunai milik pesanan latihan lewat `LEFT JOIN
   pos_orders` dan `is_training = false`. Baris tanpa pasangan `pos_orders`
   (QR bayar-dulu) tetap dihitung. Alasan: uang latihan tidak pernah masuk laci,
   jadi shift campuran tidak boleh mencatat selisih palsu. Satu fungsi ini juga
   dipakai hitung buta, penjaga kas, dan tutup paksa, jadi semuanya ikut benar.
   Laporan harian (`pos-day.service.ts`) hanya tampilan dan tidak diubah.
2. **Stok (legend-13avp).** Konsumen `recipe-deduction` melewati pesanan
   latihan: `order.paid` dan `order_issue.recorded` (remake, comp) tidak
   membuat baris `recipe_deductions`, `stock_ledger`, maupun `stock.moved`;
   `order.voided` pesanan latihan tanpa deduksi tidak meninggalkan tombstone.
   Pemeriksaan di konsumen (bukan penerbit) dengan alasan yang sama seperti
   legend-gkc6b.
3. **Data lama.** Void pesanan latihan yang sudah punya deduksi tetap
   membalik. Deduksi `pending` milik pesanan latihan dilewati saat `day.closed`
   dan tetap `pending`. Deduksi latihan yang sudah `posted` tidak dikoreksi.

## 2026-11-10: Pesanan latihan tidak boleh menjurnal (legend-gkc6b)

Konteks: `accounting-auto-journal` dan jembatan stok ke buku besar
(`inventory-gl-consumer`) tidak memeriksa `pos_orders.is_training`. Event
`order.paid` terbit untuk tiap penjualan, jadi penjualan Mode Latihan masuk
buku besar sebagai pendapatan dan HPP, sedangkan laporan WS-11 sudah
mengecualikannya (legend-fr62g). Selisihnya muncul sebagai baris "Penyesuaian
buku besar". Tingkat K (uang), ditinjau satu architect.

Keputusan: pemeriksaan ada di sisi konsumen, bukan di sisi penerbit event.

1. **Satu titik per konsumen.** `isTrainingOrder` (`services/device-training.ts`)
   dipanggil di `postAutoJournal` untuk `order.paid`, `order.refunded`,
   `order.voided`, dan di `postStockSourceToGl` untuk sumber `order`. Hasilnya
   `ignored`: tidak ada jurnal, tidak ada baris parkir.
2. **Alasan di konsumen.** Penerbit ada banyak (POS, QR, delivery, koreksi) dan
   payload event tidak membawa penanda latihan. Penerbit baru yang lupa
   menandai akan lolos. Konsumen membaca `is_training` dari `pos_orders` per
   orderId, jadi semua penerbit, pengiriman ulang, dan sweep ikut tertutup
   (sweep dan pengiriman pertama lewat fungsi yang sama). Tanpa kolom atau
   migrasi baru.
3. **Void dan refund ikut diabaikan, kecuali jurnal penjualannya sudah ada.**
   Tanpa pengabaian, keduanya diparkir `AUTO_JOURNAL_SALE_MISSING` selamanya
   karena jurnal penjualannya memang tidak ada. Bila jurnal `aj:sale:<id>` dari
   sebelum aturan ini sudah ada, void dan refund tetap membaliknya (juga
   `return` stok yang sumbernya sudah terposting), supaya buku tidak setengah
   terbalik. Sumber stok latihan yang dulu terblokir dilepas dari
   `inventory_gl_blocked`, supaya sweep tidak mengulanginya terus.
4. **Tidak ada baris `pos_orders`** (QR bayar-dulu, id tidak dikenal) bukan
   latihan: tetap menjurnal seperti biasa. Pesanan QR tidak punya mode latihan.
5. **Tidak diubah:** pemotongan stok `recipe-deduction` untuk pesanan latihan
   (PRD dan kode tidak punya aturan; hanya jurnal HPP-nya yang ditutup),
   `payment.*` (uang gateway sungguhan, bukan pesanan), settlement (berbasis
   bank). `cashier_shift.closed` tidak diperiksa di sini, tetapi
   `computeShiftAggregates` (`pos-shift-support.ts`) menghitung tender tunai
   pesanan latihan ke kas yang diharapkan, sehingga satu shift campuran bisa
   mencatat selisih kas palsu. Dilaporkan sebagai kartu terpisah.
6. **Data lama:** jurnal latihan yang sudah terbentuk sebelum perbaikan ini
   tidak dihapus atau dikoreksi otomatis; perlu keputusan finance.

## 2026-11-10: Audit retention purge with a dedicated maintenance identity (legend-usyi)

Context: `app.purge_expired_audit_logs(tenant)` (migration 0008) existed but
nothing scheduled it, and it only ran as the table owner. Audit rows are
append-only; only the owner may delete, and only rows 2 years or older
(PRD 2: "audit log ... 2 tahun"). Reviewed with an architect consult.

1. **Dedicated identity.** Group role `legend_maintenance` (NOLOGIN, NOBYPASSRLS,
   no table or sequence grant) plus login `legend_maint_<16hex>`, member only of
   that group, never of `legend_app`, owning nothing. Not a superuser, not a
   user identity. It reaches `audit_logs` only through two SECURITY DEFINER
   functions: `app.audit_retention_due_tenants()` and
   `app.purge_audit_retention_batch(tenant, batch)`.
2. **Passing FORCE RLS and the owner-only guard.** The functions are owned by the
   `audit_logs` owner, so `current_user` inside them is the owner and the
   existing guard trigger accepts the DELETE. The guard is unchanged: it still
   refuses rows younger than 2 years. Each function also sets
   `app.tenant_id` and filters on `tenant_id`, so it stays correct if the owner
   ever loses BYPASSRLS. Hardening: `search_path = pg_catalog, pg_temp`,
   schema-qualified names, no dynamic SQL, `REVOKE ALL FROM PUBLIC`, EXECUTE only
   to `legend_maintenance`. The old `purge_expired_audit_logs` is dropped.
3. **Per tenant, bounded batches.** Tenants with expired rows are listed (all
   statuses, so archived tenants are purged too). Each batch deletes at most
   1000 rows (`FOR UPDATE SKIP LOCKED`), one transaction per call; about 200
   batches per tenant and a 20 minute budget per run, the rest waits for the
   next day. A rerun deletes nothing and writes nothing.
4. **Trail.** Each batch that deletes rows inserts one `audit.retention_purged`
   row in the same transaction (actor type `system`; deleted count, cutoff,
   class). No ids, actors or content of deleted rows. A delete cannot land
   without its summary. The summary expires after its own 2 years.
5. **Scheduling and concurrency.** pg-boss queue `audit-retention-purge`, policy
   `exclusive`, cron `30 2 * * *` Asia/Jakarta, cloud worker only. `SKIP LOCKED`
   keeps two overlapping runs from double deleting, so no advisory lock.
6. **Config.** `MAINTENANCE_DATABASE_URL` in `worker.env` only (same host and
   database as the migration URL, different user from app and worker). Required
   at production start on the cloud worker; `verifyMaintenanceConnection`
   refuses a login that is in `legend_app`, has elevated attributes, owns an
   RLS table or is not in `legend_maintenance`.
7. **Not done.** Edge databases are not purged (follow-up bead). The only
   retention class is `audit_2y`; a class-to-days map is not introduced because
   the CHECK constraint allows one class.

## 2026-11-10: WS-12 provider AI per tenant (legend-dwrr)

Konteks: provider AI saat ini satu untuk seluruh platform (`AI_PROVIDER`,
`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` di `config/env.ts`, dibangun sekali
oleh `lib/ai/provider-factory.ts`). Semua panggilan model lewat `aiComplete`
(`services/ai-gateway.service.ts`) dengan `AccessSnapshot` yang membawa
tenant, jadi resolusi per tenant cukup diganti di satu titik. Tingkat K
(rahasia, akses): review architect, second-opinion Codex sebelum rilis.

1. **Tabel baru `ai_provider_configs`** di file baru
   `apps/api/src/db/schema/ai-provider.ts` (bukan di `ai.ts`, supaya tidak
   bertabrakan dengan cabang WS-12 lain). Satu baris per tenant:
   - `id` uuid PK `defaultRandom()`;
   - `tenant_id` `tenantIdColumn(() => tenants.id).notNull()`, `uniqueIndex`
     `ai_provider_configs_tenant_key` (satu config per tenant);
   - `connection_type` varchar(20) `$type<AiConnectionType>()` NOT NULL
     default `'api_key'`, CHECK `IN ('api_key','chatgpt_oauth')`.
     `chatgpt_oauth` hanya dicadangkan: service menolaknya, OAuth tidak dibangun;
   - `base_url` varchar(500) NOT NULL (sudah dinormalisasi, tanpa `/` akhir);
   - `default_model` varchar(200) NOT NULL;
   - `api_key_encrypted` text NULL (amplop `sealSecret`, base64);
   - `api_key_key_version` smallint NULL (byte versi amplop, untuk rotasi);
   - `api_key_last4` varchar(4) NULL;
   - `api_key_set_at` timestamptz NULL, `api_key_set_by` text NULL (user id);
   - `last_test_status` varchar(10) NULL, CHECK `IN ('ok','failed')`;
   - `last_tested_at` timestamptz NULL;
   - `last_test_error_code` varchar(40) NULL: **kode** dari katalog tetap
     (butir 9), bukan teks galat provider. Pesan untuk UI diambil dari katalog;
   - `created_at`, `updated_at` (`$onUpdate`).
   CHECK `ai_provider_configs_key_check`: `connection_type <> 'api_key' OR
   (api_key_encrypted IS NOT NULL AND api_key_key_version IS NOT NULL AND
   api_key_last4 IS NOT NULL)`. CHECK `ai_provider_configs_test_check`:
   `last_test_status IS NULL OR last_tested_at IS NOT NULL`.
2. **RLS** di `apps/api/src/db/schema/ai-provider.custom.sql`:
   `SELECT app.enforce_tenant_rls('public.ai_provider_configs'::regclass);`.
   Baris tingkat tenant, tanpa `outlet_id`, jadi tanpa outlet RLS. Tanpa
   SECURITY DEFINER: semua pembaca punya tenant dari `withTenant`.
3. **Migrasi** `apps/api/drizzle/0188_ai_provider_configs.sql`, satu migrasi:
   DDL hasil drizzle lalu isi `.custom.sql` di bawahnya (pola 0184). Journal
   `idx` 188, `when` 1794267000000, plus `meta/0188_snapshot.json`.
4. **Enkripsi: pakai `lib/secrets.ts`**, tanpa helper baru. AES-256-GCM dengan
   `DATA_ENCRYPTION_KEY` (wajib di production). AAD
   `ai_provider_config:<tenantId>:<rowId>`, jadi blob yang disalin ke baris
   atau tenant lain gagal dibuka. Id baris dibuat di service (`randomUUID()`)
   sebelum seal, untuk insert pertama. Versi: tambahkan ke `lib/secrets.ts`
   ekspor `sealedVersion(sealed)` dan `currentSealVersion()` (logika yang sama
   dengan `platform-integration.service.ts`; file itu tidak disentuh di cabang
   ini). Rotasi: `rotateAiProviderKeys()` di service membuka lalu menyegel ulang
   setiap baris yang `api_key_key_version` berbeda dari versi sekarang, pola
   `rotateIntegrationCredentials`. Dipasang di tempat yang sama dengan
   pemanggil `rotateIntegrationCredentials`.
   `api_key_last4` = 4 karakter terakhir kunci yang sudah di-trim. Kunci minimal
   16 karakter, jadi 4 karakter tidak membuka bagian berarti.
5. **Izin: pakai `ai.governance.manage`**, tanpa kode baru (kode baru =
   perubahan kontrak WS-00). Kode ini dipegang `tenant_admin` dan owner, bertag
   `access_admin`. Tidak ada rute Panel Platform di cabang ini (lihat
   pertanyaan founder).
6. **Kontrak** di file baru `packages/shared/src/ai/provider.ts`, diekspor dari
   `packages/shared/src/ai/index.ts`:
   - `AI_CONNECTION_TYPES = ["api_key","chatgpt_oauth"]`,
     `aiConnectionTypeSchema`, `AiConnectionType`;
   - `AI_PROVIDER_TEST_ERROR_CODES = ["URL_BLOCKED","REDIRECT_REFUSED",
     "TIMEOUT","AUTH_FAILED","NOT_FOUND","REQUEST_REJECTED","RATE_LIMITED",
     "PROVIDER_ERROR","NETWORK_ERROR","BAD_RESPONSE","KEY_UNREADABLE"]`,
     `aiProviderTestErrorCodeSchema`, plus `aiProviderTestErrorMessages`
     (teks Indonesia tetap, aman ditampilkan);
   - `aiProviderConfigSchema` (strict): `connectionType`, `baseUrl`,
     `defaultModel`, `hasKey: boolean`, `keyLast4: string(4) | null`,
     `keySetAt: isoDateTime | null`, `lastTest: { status: "ok"|"failed",
     testedAt, errorCode: code | null } | null`, `updatedAt`. **Tidak ada
     field kunci** di skema baca mana pun;
   - `aiProviderViewSchema` = `{ config: aiProviderConfigSchema | null,
     fallbackAvailable: boolean }` (`fallbackAvailable` = provider env ada);
   - `upsertAiProviderConfigInputSchema` (strict): `connectionType`,
     `baseUrl` (trim, 1..500), `defaultModel` (trim, 1..200,
     `/^[\w.:/@+-]+$/`), `apiKey?` (trim, 16..500, `/^\S+$/`). Tanpa
     `tenantId` (TEN-02);
   - `aiProviderTestResultSchema` = `{ status, testedAt, errorCode | null }`;
   - endpoint `getAiProviderConfig` GET `/api/ai/provider`,
     `upsertAiProviderConfig` PUT `/api/ai/provider`, `deleteAiProviderConfig`
     DELETE `/api/ai/provider`, `testAiProviderConfig` POST
     `/api/ai/provider/test` (body `z.strictObject({})`). Semua respons
     `dataResponseSchema(...)`; DELETE mengembalikan `{ data: view }` dengan
     `config: null`. Nama sengaja tidak `getAiProvider` (bentrok dengan
     factory). Fixture mock ditambahkan bila tes cakupan kontrak memintanya.
   Kode galat baru di `packages/shared/src/ai/errors.ts` (status + pesan
   default): `AI_PROVIDER_URL_BLOCKED` 422, `AI_PROVIDER_KEY_REQUIRED` 422,
   `AI_PROVIDER_CONNECTION_UNSUPPORTED` 422, `AI_PROVIDER_NOT_CONFIGURED` 404,
   `AI_PROVIDER_TEST_TOO_SOON` 429.
7. **Rute** di file baru `apps/api/src/routes/ai-provider.routes.ts`, dipasang
   di `routes/index.ts` dengan `apiRouter.use("/ai", aiProviderRouter)` di
   sebelah `aiGovernanceRouter`. Gate per rute (bukan `router.use`), urutan:
   `requireAuth, requireTrustedOrigin, requireTenantContext,
   requireBackOfficeSurface(), requireTenantPermission("ai.governance.manage")`,
   lalu `jsonBody` untuk PUT dan POST. `requireBackOfficeSurface` memaksa MFA
   untuk peran `mfaRequired`. `requireTenantPermission` sudah memasang
   `Cache-Control: private, no-store`. Service dipanggil dengan
   `getScopedTenantContext(req)` dan `getAuth(req).user.id`.
8. **Aturan simpan (PUT)** di `apps/api/src/services/ai-provider-config.service.ts`:
   - `chatgpt_oauth` ditolak `AI_PROVIDER_CONNECTION_UNSUPPORTED`;
   - `baseUrl` dinormalisasi (buang `/` akhir), lalu `checkAiUrl(url, true,
     resolve)`. **URL milik tenant selalu strict, juga di dev dan test**:
     tenant tidak pernah dipercaya menunjuk jaringan internal. Model lokal
     (Ollama) di dev tetap lewat env. Alasan ditolak dikirim sebagai pesan
     `AI_PROVIDER_URL_BLOCKED` (teks url-guard, tanpa kunci);
   - config baru tanpa `apiKey`, atau `baseUrl` berubah tanpa `apiKey` baru:
     `AI_PROVIDER_KEY_REQUIRED`. Jadi admin tidak bisa memindahkan kunci lama ke
     host lain untuk mencurinya;
   - `apiKey` absen dan `baseUrl` sama: kunci lama dipertahankan;
   - setiap perubahan `baseUrl`, `defaultModel` atau kunci mengosongkan
     `last_test_*`;
   - `recordAudit` untuk simpan dan hapus. Snapshot hanya `connectionType`,
     `baseUrl`, `defaultModel`, `hasKey`, `keyLast4`;
   - DELETE menghapus baris (hard delete, tanpa riwayat), 404
     `AI_PROVIDER_NOT_CONFIGURED` bila tidak ada.
9. **Uji koneksi (POST /test)** menguji config **tersimpan**. Body kosong, jadi
   kunci tidak lewat jalur ini lagi. File baru `apps/api/src/lib/ai/provider-probe.ts`,
   `probeOpenAiCompatible({ baseUrl, apiKey, model, timeoutMs, fetch?,
   resolve? })`, mengembalikan `{ status, errorCode }`, tidak pernah throw:
   - `checkAiUrl(url, true, resolve)` dulu; ditolak = `URL_BLOCKED`, tanpa fetch;
   - satu `POST <baseUrl>/chat/completions` berisi `{ model, messages: [{ role:
     "user", content: "Reply with OK." }], stream: false }` tanpa parameter
     token (cocok untuk semua server, tanpa adaptasi), `redirect: "manual"`,
     `AbortSignal.timeout(min(env.AI_TIMEOUT_MS, 15000))`, `maxAttempts` 1;
   - klasifikasi: 2xx dengan `choices` = ok; 2xx lain atau JSON rusak =
     `BAD_RESPONSE`; 3xx = `REDIRECT_REFUSED` (tidak diikuti); 401/403 =
     `AUTH_FAILED`; 404 = `NOT_FOUND`; 400/422 = `REQUEST_REJECTED`; 429 =
     `RATE_LIMITED`; 5xx dan lainnya = `PROVIDER_ERROR`; `TimeoutError` atau
     `AbortError` = `TIMEOUT`; throw lain = `NETWORK_ERROR`. Badan respons galat
     **tidak dibaca** (`body.cancel()`), tidak dicatat, tidak dikembalikan;
   - blob tidak bisa dibuka = `KEY_UNREADABLE`, tanpa fetch;
   - hasil ditulis ke `last_test_*`. Uji kurang dari 10 detik setelah uji
     sebelumnya ditolak `AI_PROVIDER_TEST_TOO_SOON`;
   - uji tidak lewat `aiComplete`, tidak dihitung anggaran (beberapa token, di
     kunci tenant sendiri).
   DNS rebinding: `checkAiUrl` me-resolve lalu fetch me-resolve ulang. Bila
   `undici` sudah ada di dependensi `apps/api`, probe dan provider tenant
   memakai `dispatcher: new Agent({ connect: { lookup } })` dengan lookup yang
   menolak alamat `isBlockedIp`. Bila belum ada, celah ini tetap tercatat
   (sama dengan `AI_BASE_URL` env) dan masuk daftar second-opinion.
10. **Resolusi provider.** `provider-factory.ts` mendapat:
    - `buildTenantAiProvider({ baseUrl, apiKey, model })` →
      `createOpenAiCompatibleProvider` dengan `timeoutMs: env.AI_TIMEOUT_MS`
      dan `checkUrl: (url) => checkAiUrl(url, true)`. Redirect sudah ditolak
      di provider (`redirect: "error"`);
    - `isAiProviderOverridden(): boolean` untuk `setAiProviderForTests`.
    Service mengekspor `resolveTenantAiProvider(context): Promise<{ provider,
    model, source: "tenant" | "platform" } | null>`, urutannya:
    1) override test aktif → `getAiProvider()`;
    2) ada baris tenant → `connection_type` `api_key` dan blob terbuka →
       provider tenant; `chatgpt_oauth` atau blob gagal dibuka → `null`
       (`AI_PROVIDER_UNAVAILABLE`). **Tidak jatuh ke kunci platform** bila
       tenant punya baris: salah konfigurasi tidak tersembunyi, dan platform
       tidak diam-diam membayar;
    3) tanpa baris → `getAiProvider()` (env, cadangan) dengan `env.AI_MODEL`.
    Status uji terakhir tidak memblokir pemakaian. Tanpa cache: satu query
    berindeks plus satu dekripsi per panggilan, kecil dibanding panggilan
    model, dan DELETE langsung berlaku di semua proses.
    `aiComplete` memanggil `resolveTenantAiProvider(gatewayContext(access))`
    sebagai ganti `getAiProvider()`. `recordUsage` menerima nama provider dan
    model hasil resolusi (bukan `getAiProvider()?.name` dan `env.AI_MODEL`).
    `ai-governance.service.ts` `providerAvailable` memakai resolusi yang sama.
    `settingsVersionOf` digabung dengan `updated_at` config provider, supaya
    cache jawaban lama gugur saat provider diganti.
11. **Anggaran tidak berubah.** `aiPreflight` tetap berjalan sebelum resolusi
    provider. `monthlyBudgetIdr` default `idr(0)` tetap memblokir
    (`AI_BUDGET_EXCEEDED`), apa pun sumber providernya. Pemakaian dengan kunci
    tenant tetap dicatat di `ai_usage_*` dan dihitung ke anggaran tenant
    dengan `priceFor(model)`. Model tak dikenal dihargai Opus (tidak pernah
    kurang hitung). Lihat pertanyaan founder 1.
12. **Kunci tidak bocor.** Kunci hanya ada di memori: saat seal di PUT dan
    saat membangun provider atau probe. Tidak ada di respons, audit, log,
    pesan galat, `ai_usage_events`, atau objek `AiError`. Galat Zod dari PUT
    tidak boleh menggemakan nilai `apiKey`: handler galat sudah membuang
    `input`; test membuktikannya.
13. **Test wajib, gagal dulu,** di file baru
    `apps/api/src/test/ai-provider-config.test.ts` (fetch dan resolver
    disuntik, tanpa jaringan):
    - kunci tidak muncul di body respons GET, PUT, POST test, galat 422, baris
      audit, maupun log (spy logger, `JSON.stringify` semuanya);
    - isolasi: config tenant A tidak terlihat dan tidak dipakai tenant B; blob A
      yang disalin ke baris B gagal dibuka (AAD);
    - pengguna tanpa `ai.governance.manage` (hanya `ai.ask`) mendapat 403 di
      keempat rute;
    - PUT dan test menolak `https://127.0.0.1`, `https://10.0.0.5`,
      `https://169.254.169.254`, `http://` publik, `https://localhost`, dan nama
      yang di-resolve ke IP privat; respons 302 dari probe = `REDIRECT_REFUSED`
      dan URL tujuan tidak pernah di-fetch;
    - timeout probe = `TIMEOUT`;
    - `baseUrl` berubah tanpa `apiKey` = `AI_PROVIDER_KEY_REQUIRED`;
    - anggaran 0 memblokir walau tenant punya config;
    - tenant tanpa config memakai provider cadangan dan `env.AI_MODEL`; tenant
      dengan config memanggil `baseUrl` dan `defaultModel` miliknya;
    - `chatgpt_oauth` ditolak `AI_PROVIDER_CONNECTION_UNSUPPORTED`;
    - rotasi menyegel ulang baris versi lama.
14. **Daftar file.** Buat: `apps/api/src/db/schema/ai-provider.ts`,
    `apps/api/src/db/schema/ai-provider.custom.sql`,
    `apps/api/drizzle/0188_ai_provider_configs.sql`,
    `apps/api/drizzle/meta/0188_snapshot.json`,
    `packages/shared/src/ai/provider.ts`,
    `apps/api/src/lib/ai/provider-probe.ts`,
    `apps/api/src/services/ai-provider-config.service.ts`,
    `apps/api/src/routes/ai-provider.routes.ts`,
    `apps/api/src/test/ai-provider-config.test.ts`. Ubah:
    `apps/api/drizzle/meta/_journal.json`, `apps/api/src/db/schema/index.ts`,
    `packages/shared/src/ai/index.ts`, `packages/shared/src/ai/errors.ts`,
    `packages/shared/src/ai/fixtures.ts` (bila tes cakupan meminta),
    `apps/api/src/lib/secrets.ts`, `apps/api/src/lib/ai/provider-factory.ts`,
    `apps/api/src/services/ai-gateway.service.ts`,
    `apps/api/src/services/ai-governance.service.ts`,
    `apps/api/src/routes/index.ts`. UI Kelola menyusul di slice terpisah
    mengikuti `ui-standard.md`.
15. **Pertanyaan founder** (default dipakai sampai dijawab):
    1) Pemakaian dengan kunci AI milik tenant tetap dihitung ke anggaran AI
       bulanan tenant (dengan harga platform)? Default: ya, supaya anggaran 0
       tetap menghentikan semua AI.
    2) Super Admin di Panel Platform boleh melihat atau mengatur provider AI
       tenant? Default: tidak; hanya admin tenant dan owner.

Celah yang diketahui: DNS rebinding (butir 9) bila `undici` tidak tersedia;
model tenant di luar daftar harga dihitung dengan harga Opus.

## 2026-11-10: WS-07 cash & bank reconciliation (legend-fnxl)

Context: PRD v1.7 §3.19 "Kas & Bank [P0]", ACC-04 (auto-match ≥ 99%, every
difference a case with a PIC), ACC-05 (undeposited-cash alert). The contract
(`packages/shared/src/accounting/banking.ts`, endpoints) already existed
without tables or handlers. Kas-bank only; gateway/EDC settlement matching
waits for legend-cs7 (card legend-fnxl.8). Reviewed by one architect
subagent before the schema landed.

1. **One migration, `0191_cash_bank_recon`** (`when` 1794270000000, prevId =
   0186 snapshot). Every foreign key sits inside its `CREATE TABLE`
   (contracts.md FK-into-FORCE pattern 1); tables are created in dependency
   order. Tenant RLS on all seven tables; `cash_deposits` (outlet_id NOT
   NULL) also gets outlet RLS. Bank accounts, imports, lines, matches and
   cases (nullable outlet) rely on the service layer for outlet reach.
2. **Entity-level work needs tenant scope.** Import, match, exclude, unmatch,
   case open and bank-account writes call `assertTenantScope`: outlet RLS on
   deposits would hide documents from an outlet-scoped caller and could turn
   an ambiguous hit into a wrong automatic match.
3. **Account numbers are sealed** (lib/secrets.ts AES-GCM, AAD binds tenant,
   row, field and key version), indexed by a tenant-separated HMAC for
   "one number per legal entity", and only the last 4 digits are kept in
   clear for the mask. The GL account FK is (tenant, legal entity, account),
   so a bank account cannot post to another entity's CoA.
4. **Re-import adds nothing.** `bank_statement_lines` is UNIQUE (tenant, bank
   account, `dedupe_key`); lines insert with ON CONFLICT DO NOTHING and the
   skipped rows count as duplicates. The dedupe key keeps identical rows in
   one file apart by occurrence. A file with one unreadable row is refused
   whole, with a message naming the row and column.
5. **One document, one line.** Matches live in `bank_statement_line_matches`
   with UNIQUE (tenant, ref_type, ref_id), not in a jsonb column on the line.
   A collision during auto-match is skipped (ON CONFLICT DO NOTHING); in a
   manual match it is `STATEMENT_LINE_ALREADY_MATCHED`.
6. **Automatic match never guesses.** Exact amount, date within the tenant's
   `matchingPolicy.dateToleranceDays`, and unique both ways: the line has one
   candidate (shared `findStatementMatch`) and the document is wanted by one
   line. Candidates: `recorded` cash deposits into the account (local business
   date in the outlet's time zone) and journals whose net movement on the
   account's GL account equals the line, excluding reversals, reversed
   entries, journals behind a cash deposit and write-off adjustment journals.
   Matching runs over every unmatched line of the account after an import and
   after a cash deposit is recorded, so late deposits still match.
7. **Entity lock.** Every write that touches lines, matches or deposits takes
   one advisory lock per (tenant, legal entity), then row locks. Journals
   belong to the entity and its GL account, and two bank accounts may share a
   GL account, so a per-account lock would let them race for one journal.
8. **Cash collections are not stored.** ACC-05 collections are derived from
   closed `pos_shifts` per (outlet, business date):
   `cash_sales − cash_refunds − cash_out + variance`, floored at 0. The
   variance (counted minus expected) is in, so a short shift does not show
   cash that never existed as undeposited, and extra cash does show. Cash
   drops stay in the outlet (not banked) and cash in is float, so neither
   counts. Deposits in every status cover cash
   FIFO (shared `undepositedCashAlerts`); alerts are computed on read with
   `loadCashDepositPolicy`, no alert table.
9. **Cases** live in `bank_reconciliation_cases` (the gateway-specific
   `payment_reconciliation_cases` is untouched). Every action (open, start,
   reassign, resolve, write_off) writes one row in the append-only
   `bank_reconciliation_case_events` (the app role has no UPDATE/DELETE).
   A write-off only links an existing journal (same entity, not reversed,
   debit total = |difference|, used by one case: partial unique index); this
   bead posts nothing (legend-9pz9 owns automatic journals).
10. **Case due date is a server default of 7 days** (`reconciliationPolicySchema`)
    until the finance policy carries `caseDueDays`: adding it now would change
    the strict PUT contract. Follow-up card filed.
11. **A line in a case stays `in_case` after the case closes.** Resolving or
    writing off the case is how that line is reconciled; unmatch refuses
    `in_case` lines, and deposits in a case stay `discrepancy`. Refs of type
    `gateway_settlement`, `edc_settlement` and `supplier_payment` are stored
    on a case as given until legend-cs7 can validate them; nothing acts on them.
12. **An unmatched pair is never auto-matched again.** Unmatch writes the
    (line, document) pair to `bank_statement_match_rejections`; automatic
    matching skips it. A person can still match that pair by hand, which
    clears the row (review finding, 2026-11-10).
13. **Uniqueness is counted per GL account, not per bank account.** Two bank
    accounts of one entity may share a GL account, so the "only one line
    wants this document" test counts candidate lines of every bank account on
    that GL account. A document named in a case that is still open is no
    candidate, cannot be matched by hand, and a case cannot name a document
    that is already matched (one document, one place).
14. **Opening a case is idempotent** (`idempotencyKey` added to the
    open-case body, stored in `bank_reconciliation_cases.idempotency_key`),
    like every other cash-bank command.
15. **The dedupe key keeps its readable format** (the web preview compares
    keys); a row whose normalized key exceeds 400 characters is refused with
    STATEMENT_VALUE_INVALID instead of failing the insert.

## 2026-11-10: Member identity and point ledger (legend-k2l, legend-111j, legend-u57q)

Context: the member page (legend-u57q) has a UI but no backend. Customers
already sign in with WhatsApp reverse OTP, which creates rows in the Better
Auth `user` table; there is no customer profile, ledger, rewards or member
authorization. Full design and card plan: `docs/design/ws08-member-loyalty.md`.

1. **One person table.** Members and staff share the Better Auth `user` table;
   membership is a `customer_profiles` row per tenant, staff access a role
   assignment. A second Better Auth instance was rejected: it would rewrite the
   tested WhatsApp login and hide the cashier-is-the-member link that the
   self-serve ban needs. Every member table keys on `customer_profile_id`, so
   the cookie can still move to its own instance later.
2. **Member sign-in = WhatsApp, email magic link, Google.** All mint customer
   sessions. The email magic link runs on the existing `login_challenges` flow
   (AUTH-01: 15 minutes, single use, keyed digest), not the Better Auth
   `magicLink` plugin. Each session records `auth_method`; only a `password`
   session upgrades to management, so an inbox or a WhatsApp code can never
   replace a staff password plus MFA. Staff may sign in with a member method
   and get customer-only access (403 on staff routes). The self-serve ban still
   stops them earning on their own sales. Email and Google stay off until their
   keys exist. Points need a verified WhatsApp (AUTH-07).
3. **Merge only WhatsApp-only accounts.** Proving a number held by an account
   with no other identity, no role and no platform access merges it into the
   signed-in account; everything else is refused with
   `IDENTITY_MERGE_NEEDS_SUPPORT`. Profiles move, the ledger does not. A magic
   link verified in another browser (`auth_cross_device`) cannot link WhatsApp
   or merge: 403 `IDENTITY_LINK_REAUTH_REQUIRED`.
4. **The database keeps the money rules.** `point_ledger` is append-only, the
   balance column is maintained only by an insert trigger and cannot go below
   zero, writers lock the profile row, and the unique source key makes every
   paid, refund, redemption and expiry posting happen once. A trigger copies the
   point value onto every row and locks it at the first posting, so the
   liability sum always matches outstanding points.
5. **Member isolation in two layers.** `requireMember` turns the session into
   a `MemberScope` that services take as their only identity input, and a
   RESTRICTIVE `member_self` policy keyed on `app.customer_profile_id` hides
   other members' rows if a query forgets its filter.
6. **Earn from the existing outbox events.** `order.paid` and
   `order.refunded` drive a `loyalty-earn` consumer; the member comes from the
   order row. Base = gross sales minus discount minus points tender, before
   service and PBJT. Partial refunds reverse cumulatively, rounded against the
   member, clamped at the balance with an anomaly row. A void of a paid POS
   sale (`order.voided` with `voidedFinalOrder`) reverses all remaining points.
7. **Consent from the member app** is written with source `member_pwa` against
   a versioned `consent_policy_versions` row; an outdated version is refused.
8. **Defaults until the founder decides (A15, 30 Nov):** program inactive,
   Rp10.000 = 1 point, point value Rp100, 12-month expiry and tier window,
   daily cap 1.000 (contract default), self-serve ban on, referral off, points tender off. All are
   settings, not code.
9. **Restore keeps the original expiry.** A cancelled or expired redemption
   puts its points back as a positive `adjust` row that points at the redeem
   row, so the restored points keep the expiry of their grant.

## 2026-11-10: Split bill per order, per-part payment and claim tokens (legend-ms3)

Context: PRD v1.7 §3 F10 Split Bill and "Klaim Poin per Orang", §6.D
`bill_splits`, ORD-06. The shared contract (`splitBill`, `billSplitSchema`,
`createSessionSplits`, pay target `split`) existed; the API side did not.

1. Scope is one order: the session's single `awaiting_payment` order (pay-first).
   No awaiting order answers 422 `NOTHING_TO_SPLIT`; more than one answers 409;
   an order with an applied reservation deposit answers 422. Session-level
   splits stay reserved in the contract (`orderId` nullable) until a
   session-level payment flow exists.
2. One table `bill_splits`, one row per part, grouped by `split_set_id`
   (no header table; `qrOrderIdempotent` handles the request key). by_item
   assignments are a `uuid[]` of order item ids, checked under the order lock.
   A partial unique index on live parts stops two concurrent live sets.
   `payment_intents.bill_split_id` gets a composite FK to it.
3. Rounding reuses `splitBill()` (largest remainder) on `orders.total_idr`, which
   already holds tax, service and rounding, so parts sum exactly to what the
   payment link collects. A zero part is refused (an intent must be above 0).
4. Each part pays through its own payment intent on the order's single payment
   link (`createSplitPartIntent`): the amount is the part, bounded by the link's
   outstanding balance, and only that part's pending code is superseded, so
   several guests can pay at once. The order turns paid through the existing
   rule (link paid >= link total); the part turns paid in the payment consumer
   from `intent.bill_split_id`, replay-safe by a conditional update.
5. Re-split is refused (409 `SPLIT_LOCKED`) once any part is paid, any money
   reached the link, or any code on the link is still payable. Otherwise the
   live parts are voided and a new set is written.
6. Unpaid-order sweep counts payment attempts per part, so a 4-way split is not
   voided for attempts; when an order with money on it is voided, each paid
   intent goes through the existing late-payment refund request.
7. Claim token per part: issued when the part is paid, valid 24 hours from
   that moment, stored as a sha256 hash plus a sealed copy so the guest can
   read it again; redeemed once by a conditional update. No public redeem
   route and no points until the member point ledger (legend-111j) lands.
   When the order is voided, its unpaid parts are voided and the paid parts'
   claims end at once; redeeming needs a paid part on an order not voided.
8. One payable code per part (architect review K). A superseded code stays
   payable at the gateway until its own expiry, and a second payment on one
   part would not show as an overpayment of the bill. So a part answers 409
   `SPLIT_CODE_ACTIVE` to a different method while its code, or a superseded
   code still inside its expiry plus the late-payment grace, can be paid; the
   same method returns the same code. Re-split also waits for such codes.
   Trade-off: a guest who switches from VA to QRIS waits for the VA code to
   lapse (up to the VA lifetime).
9. A guest reads the claim only while the table session credential is valid;
   after the table closes, the receipt carries the token (legend-arp35,
   legend-90na8).

## 2026-11-10: WS-10 lifecycle: checklists, exit clearance, settlement summary, KPI (legend-ovxw)

Context: PRD F24 (onboarding/offboarding: checklist per jabatan, exit
clearance with asset return and access/device revocation, final entitlements,
work certificate) and F29 (KPI per jabatan from system data or manager
judgement, monthly or quarterly review). Nothing existed on m1. Designed with
an architect consult; tier K (access revocation, money summary).

1. **Seven tenant tables, one migration (0206).** `hris_checklist_templates`
   (items as jsonb validated by `checklistTemplateSchema`, one active template
   per tenant+kind+position, null position = default), `hris_checklist_tasks`
   (instances; `block_reason` / `waive_reason` required by CHECK when the
   status says so; `system_managed` tasks cannot be completed by hand),
   `hris_checklist_task_actions` (append only, `UPDATE`/`DELETE` revoked from
   `legend_app`; block and waive need a reason), `hris_offboardings` (one
   non-cancelled row per employee; status open → revoked → completed, or open
   → cancelled), `hris_kpi_definitions` (`metric_code` set exactly when
   `source = system`), `hris_kpi_reviews` (one per employee, cycle and period
   start), `hris_kpi_scores` (definition snapshot, system actual with its
   availability, manager actual and score). Every table has tenant RLS
   forced; none has a NOT NULL `outlet_id`, so outlet reach is checked in the
   service through the employee's home outlet, like `employees`.
2. **The login account is shared across tenants, so it is never banned.**
   Exit clearance (`POST /api/hris/offboardings/:id/revoke-access`) runs in
   one tenant transaction, after the last working day only (on the last day
   itself: 409 `EXIT_NOT_DUE`, the employee still works that shift). It is a
   tenant-wide action: the caller needs `hr.employee.manage` held tenant-wide
   (an outlet-scoped HR manager gets 403 `CLEARANCE_NEEDS_TENANT_HR`), so the
   leaver's role assignments and shifts at every outlet are in reach. Steps:
   1. the tenant role-assignment advisory lock
      (`legend:role-assignment-end:<tenant>`, the key `endRoleAssignment`
      takes), then `now` is read, then the offboarding row `FOR UPDATE`; a
      row already revoked returns its stored `revocation_result` without
      writing anything, so a second call equals the first;
   2. every active or future role assignment of the employee's user in this
      tenant is ended with reason `offboarding`, each with the
      `role_assignment.ended` event and audit row. A future assignment gets
      an empty window (`valid_until = valid_from`, never valid because
      `valid_until` is exclusive); `role_assignments_window_check` becomes
      `>=` for that. An employee who holds an Owner assignment is refused
      (409 `OFFBOARDING_OWNER`): the Owner is replaced through the access flow
      first. An employee with a tenant-scoped assignment needs a caller who
      also holds `access.role.assign` tenant-wide (else 409
      `OFFBOARDING_ADMIN_ROLE`), so HR alone cannot strip an admin. The helper
      is a new function appended to `access.service.ts`; `endRoleAssignment`
      itself is not touched, because `ws/end-role-assignment-lock` is changing
      it;
   3. the user's staff sessions are revoked (`revoked_at`, expiry moved to
      creation + 1 ms): non-customer, non-impersonated sessions with this
      tenant or with no tenant (nothing fills `session.tenant_id` yet). The
      person signs in again for any other tenant. Customer and impersonated
      sessions are left alone;
   4. the user's web push subscriptions in this tenant are deleted, so the
      phone stops receiving this tenant's notifications;
   5. shifts after the last working day that are not cancelled are locked,
      re-checked to still belong to the leaver (a swap may have moved them),
      and cancelled through `cancelShiftAssignmentInTx`, split out of
      `cancelShiftAssignment` without changing it (swap withdrawal,
      `shift.cancelled` event and audit stay);
   6. staff PIN rows are kept. `attemptStaffPin` already answers `not_member`
      once the role assignments end, a deleted row would never reach an edge
      node (the export has no tombstone), and a rehire reuses the key;
   7. outlet devices are not revoked: `devices` are outlet hardware with no
      user. The person's own devices are their sessions and push
      subscriptions (steps 3 and 4);
   8. the employee becomes `terminated` (termination) or `resigned`
      (resignation, contract end), `end_date` = last working day; open
      `access_revocation` tasks become done with an action row; the
      offboarding row stores the result; one audit row with counts only.
      An offline edge node keeps accepting the PIN until it pulls the ended
      assignments. Revocation does not run by itself on the last day: a job is a
      follow-up bead.

   Automatic clearance (legend-arj.6) runs the same steps from the worker as
   the **system actor**, `{type:"system"}` (same shape as `hris-leave`):
   - audit rows get `actor_type = 'system'`, `actor_id = NULL`; the event
     envelope actor is `{type:"system"}`;
   - every uuid/text column that records "who" (`ended_by` in the event
     payload, `cancelled_by`, `access_revoked_by`, `done_by`, the task action
     `actor_user_id`) holds the nil UUID
     `00000000-0000-0000-0000-000000000000` (`SYSTEM_ACTOR_ID`). The UI shows
     it as "Sistem". No migration: the columns are text;
   - the system run uses `canAssignRoles = false`. An Owner leaver
     (`OFFBOARDING_OWNER`) or one with a tenant-scoped role
     (`OFFBOARDING_ADMIN_ROLE`) rolls back, is logged, and the offboarding
     stays open for a human with `access.role.assign`. A job must never strip
     a company-level role by itself;
   - the worker never installed an audit writer (only `app.ts` called
     `setAuditWriter`), so the role-assignment end inside clearance would have
     failed closed with 503. `worker-main.ts` now installs `coreAuditWriter`
     at startup.
3. **KPI system actuals go through `evaluateMetrics`.** The `employee`
   dimension value of `metrics_daily` is the user id (`orders.cashier_id`,
   `pos_shifts.cashier_id`), so an employee without a user account gets
   `no_user_account`. A definition may only name a catalog metric that
   declares the `employee` dimension, with the catalog unit. Actuals are
   computed when a review is created and on refresh while it is a draft; a
   submitted review is frozen. An unavailable metric stores null with its
   reason and the reviewer enters a manual actual. `kpiScoreSchema.actual`
   becomes signed and nullable (cash variance can be negative; a draft has no
   value yet); submit needs a score on every row. The system actual of one
   employee is computed tenant-wide (every outlet the person worked at),
   whoever refreshes it; the caller still needs reach over the employee.
4. **The final settlement is a summary of recorded data, not a payment or
   a calculation.** Running salary (last payroll run covering the employee,
   its period end, and the unpaid business days from the day after it up to
   the last working day; no amount), outstanding kasbon, approved unpaid
   reimbursements, leave balances (days only, no cash value), and a
   `pendingPayrollEngine` list naming what is not computed yet (prorated
   salary, THR, BPJS, leave cash-out, net payout). No THR or BPJS arithmetic
   runs here and no net is shown: those wait for the payroll engine
   (legend-j2l2, follow-up bead). The pure kasbon and reimbursement helpers
   move from the web preview into `packages/shared/src/hris/lifecycle.ts`.
   Completing the offboarding freezes the summary in `settlement_snapshot`.
5. **Work certificate: render data plus a PDF on the existing pdf-lib
   pattern** (`purchasing-po-pdf.ts`). Available to HR (`hr.employee.manage`) once
   access is revoked; numbered once per offboarding. The leaver has no access
   left after clearance, so HR hands the PDF over; self-service for former
   employees is legend-arj.7.

## 2026-11-10: Metric sources, metrics_daily and report runs (legend-5wzoc, legend-31fi)

Context: founder Q54 puts all 110 standard reports and 89 metrics in scope
before release. On m1 only `GET /api/metrics/query` answers, for 12 money
metrics read from posted journal lines and split by outlet only; every other
metric answers null. Twelve family cards (F1-F12) build the remaining sources
in parallel. Reviewed with an architect consult before implementation.

1. **Money totals stay on the ledger; other splits come from the sub-ledger
   with the ledger as control.** A money metric whose figure the ledger posts
   (`GL_METRIC_SOURCES`) keeps its ledger total for every query. A split the
   ledger cannot carry (channel, menu item, hour, employee, payment method,
   ...) is read from operational rows (orders, order items, payments) through
   `metrics_daily`. The rows of such a split are always followed by one
   residual row, dimension value `__ledger_adjustment__` (shown as
   "Penyesuaian buku besar"), equal to the ledger total minus the sum of the
   split rows for the same bucket and outlet filter. The rows therefore add
   up to the ledger total, like the "Tingkat badan usaha" series of the
   outlet split (DASH-02). The residual row is shown whenever it is not zero;
   there is no tolerance that hides it. Split rows are never scaled pro rata
   to the ledger: a scaled per-menu or per-employee figure would be a number
   nobody recorded. Split rows carry the finality of the ledger total of
   their bucket. A percent metric split this way (food cost % per menu) is
   recomputed per row from its split numerator and denominator; the residual
   row gets the ratio of the residual components, null when the residual
   denominator is zero. The old I1 rule (`metrics-query.service.ts` header)
   is narrowed to: a money total never comes from operational rows when the
   ledger posts it. A money metric the ledger never posts (void amount, pax
   spend, settlement in transit) may read operational rows directly; its
   family card states why in the source's comment and removes it from
   `NON_GL_MONEY_METRICS`.
2. **One registry, one engine.** `apps/api/src/services/metric-sources/`
   holds exactly one `MetricSource` per registry metric code (`gl`, `daily`,
   `derived` or `unavailable`) and at most one `MetricSplitSource` per
   (ledger metric, dimension). The 12 ledger sources live in
   `metric-sources/gl.ts`; each family file adds its own sources and splits
   and never edits another file. A code no family claims resolves to
   `unavailable` (`source_not_built`), so all 89 codes always resolve. The
   registry refuses at load a code claimed twice, a code missing from the
   catalog, a unit that does not fit the source kind, and a split on a code
   that is not `gl`. `evaluateMetrics` in `metrics-query.service.ts` is the
   only path that turns codes into values. `GET /api/metrics/query`, report
   run and preview (`report-run.service.ts`), the dashboard batch (F11) and
   the AI tools all call it. The AI helpers in
   `apps/api/src/services/ai-metrics/` (sales, finance, labor, stock) still
   compute registry metrics from operational tables, for example `net_sales`
   from orders. The card that owns each metric moves its helper onto the
   engine: sales to F1, stock to F5, finance to F6, labor to F9. The guard
   test `metric-single-path.test.ts` lists these four files as the only
   allowed exceptions, and INT requires the list to be empty.
3. **`metrics_daily` plus a batch engine for the 3-second dashboard.**
   `metrics_daily` stores outlet-day values of `daily` sources and of splits
   (tenant and outlet RLS forced). Ledger totals stay live from journal lines
   in the existing REPEATABLE READ READ ONLY snapshot, so a close or reopen
   is never stale. `evaluateMetrics` takes many codes for one period, bucket
   and outlet filter, and makes one ledger read and one `metrics_daily` read
   per call. F11 groups the 18 owner tiles by (period, bucket, outlet
   filter) and evaluates them in one snapshot. The p95 budget for one owner
   dashboard load is 3 s. F11 measures it on a seed of 10 outlets and 400
   days. If the ledger read alone exceeds 1 s p95 there, F11 adds a daily
   ledger roll-up as its own bead; A does not build one now. Ratios
   (`aggregation: ratio`) are never stored; they are recomputed from their
   input codes per bucket. A report run groups by the outlet and at most one
   other dimension in this release. A deeper group-by answers "belum
   tersedia" (`dimension_not_supported`) instead of a wrong table.
4. **Closed versus estimate.** A stored row is `final` only when its business
   day has settled (day end plus the settle delay, as in the AI daily
   summary). Point-of-sale metrics also need a `pos_daily_closes` row for
   that outlet and date. Every other row is `estimate`. On read, a value is
   `final` only when every stored row behind it is `final` and
   `metricValueFinality` says `final` now. `closed_period_only` metrics also
   need closed books (`bookState`). So a reopened month or a late
   recomputation turns a value back into an estimate without waiting for the
   job. `requireFinal` keeps refusing with `PERIOD_NOT_CLOSED` before any
   value is read; an unavailable metric is not counted in that check.
5. **The daily job is idempotent per outlet and date.**
   `worker/metrics-daily.job.ts` runs from the worker tick per tenant, every
   15 minutes. It handles today (estimate) and the last 7 settled business
   dates per open outlet. Each (tenant, outlet, date) takes a transaction
   advisory lock. Each family runs in its own savepoint, so a failing family
   is logged and retried on the next tick without blocking the others. The
   rows of a code are upserted on the unique key and rewritten only when the
   value, finality or definition version changes, so a rerun leaves
   `updated_at` unchanged. Rows of that code whose dimension no longer exists
   are deleted. A changed `final` row is logged as `metrics_daily final row
changed` (late data) and still written. Dates older than the window are
   recomputed only through `recomputeMetricsDaily(context, outletId, from,
to)`. A family card that bumps a definition version runs it over the
   history it changes. A family card that ships a new reader also runs it
   over the history its reports cover, before its reports leave the mock.
   Every reader writes a total row (no dimension) per outlet-day, zero when
   nothing happened; a stored value is `final` only when every business day
   of its bucket has that total row, so a day the job never computed (worker
   down for more than the window, a reader shipped without backfill) keeps
   the value an `estimate` instead of a closed figure that silently misses
   days (architect review 2026-11-10).
6. **"Belum tersedia" is a field, not a zero, an error or an empty row.**
   Report results (`reportResultSchema`) and metric series carry an
   availability per metric: `available`, or `unavailable` with a reason
   (`source_not_built`, `dimension_not_supported`) and an Indonesian message.
   An unavailable metric has null in every cell. A report whose metrics are
   all unavailable answers 200 with no rows and every metric marked
   `unavailable`, so the viewer, the dashboard and Tanya AI can say "belum
   tersedia". The low-level `GET /api/metrics/query` keeps answering 400
   `METRIC_DIMENSION_NOT_SUPPORTED` for a split the metric does not declare
   (unchanged). A split the metric declares but no card has built yet is
   marked `unavailable` by the engine and by report runs; `GET
/api/metrics/query` keeps its m1 answer (400) for that case too, so the
   existing ledger regression tests stay unchanged. A split of a percent
   ledger metric is `dimension_not_supported` until a family card builds its
   numerator and denominator splits. Report run rows carry their bucket
   (`bucket` on the result, `bucketStart`/`bucketEnd` on each row; for
   `total` both equal the period bounds), so `day`, `week` and `month`
   reports answer one row per bucket and split; rows order by bucket, then
   dimensions, `sort` applies inside a bucket and `limit` counts all rows
   (legend-ymtsg, brief 267). A run splits by `outlet` plus at most
   `REPORT_RUN_MAX_SPLIT_DIMENSIONS` (1) other dimension: `metrics_daily`
   stores one dimension per row, so going deeper needs a schema change. A
   deeper `groupBy` is not refused by the schema; the run answers 200 with
   `unavailable` / `dimension_not_supported` (legend-hdfd2).
7. **File ownership.** Only card A, and after A merges only a serialized
   follow-up bead labelled `ws11-shared`, edits
   `metrics-query.service.ts`, `metrics-gl-sources.ts`,
   `metric-sources/index.ts`, `types.ts` and `gl.ts`,
   `report-run.service.ts`, `routes/reports.routes.ts`,
   `db/schema/metrics.ts`, `worker/metrics-daily.job.ts`,
   `packages/shared/src/metrics/*`, `packages/shared/src/dashboard/*` and
   `mock-day-model.ts`. A family card that needs a change there comments on
   that bead and does not edit the file in its own branch. A family card owns
   its own `metric-sources/<family>.ts`, `test/ms-<family>.test.ts`,
   `mock-families/<family>.ts`, `routes/_kelola/reports.<family>.*.tsx`, and
   any new schema file of its own migration. Report families map to source
   files as follows: sales; traffic and operations; menu and cogs; payments
   and tax; inventory and purchasing; finance; loyalty and crm; reservation
   and delivery; attendance, payroll and performance (`hr`); facility.
8. **`GET /api/metrics/query` follows the report run access rule**
   (legend-svrzc, CTO decision 2026-11-10, brief 267). Each metric's source
   report decides access: its full permission gives the caller's own scope;
   without it, `report.aggregate.view` gives the tenant aggregate only when
   the source report is on the aggregate whitelist
   (`reportAcceptsAggregateView`). Scopes intersect across the asked
   metrics; an empty intersection or no access answers 403
   `REPORT_NOT_PERMITTED`, never a tenant-wide figure. A metric code without
   a known source report keeps its old permission, without aggregate
   fallback. The shared logic lives in `routes/report-viewer.ts`. Callers
   that passed through the aggregate before without the source report now
   get 403: a shareholder asking for `cogs` (source `inventory.food_cost`,
   not whitelisted) is refused. The rule also widens access: money metrics
   no longer all need `report.financial.view`; each needs its source
   report's permission, so `report.operational.view` reads `cogs`,
   `food_cost_pct`, `waste_cost`, `payment_fee` and `stock_value`, and
   `report.sales.view` reads `net_sales` and `discount_amount`. The same
   figures were already readable through a report run (architect review
   2026-11-10).
   Founder decisions (legend-upmn7, 2026-11-10):
   - Q59: a shareholder (`report.aggregate.view`) may read the business
     total of `cogs` through `GET /api/metrics/query`, never a breakdown.
     `AGGREGATE_TOTAL_METRIC_CODES = ["cogs"]` in
     `packages/shared/src/dashboard/catalog.ts` lists such total-only
     metrics. A listed metric gets the aggregate reach only for a request
     with no `groupBy`, no `outletIds` filter and bucket `total`; any split
     (outlet, menu item, menu category), an outlet filter or a smaller
     bucket answers 403 `REPORT_NOT_PERMITTED`. The mark is per metric, so
     `food_cost_pct` from the same source report stays 403.
     `inventory.food_cost` is not added to `AGGREGATE_VIEW_REPORT_CODES`: its
     report run, with per-menu detail, stays closed to the aggregate view.
     The metric query follows the founder's words literally (whole business,
     whole period), although the `finance.income_statement` report run,
     which accepts the aggregate view, already lists `cogs` per outlet to a
     shareholder and `gross_profit` is `net_sales - cogs`; the per-menu split
     is the only detail no path shows (architect review 2026-11-10).
   - Q61 (2026-11-10): a shareholder may see the income statement per
     outlet, including each outlet's `cogs`, through the
     `finance.income_statement` report run. The per-menu `cogs` breakdown
     stays closed. The current behaviour already matches; no code change.
   - Q60: widening `report.operational.view` to `cogs`, `food_cost_pct`,
     `waste_cost`, `payment_fee` and `stock_value` is approved only within
     the outlets the role reaches. An outlet-scoped holder reads their own
     outlet without a filter and gets 403 for another outlet's filter
     (`apps/api/src/test/metrics-query-access.test.ts`).

9. **Shared round 2 (brief 272, 2026-11-10).**
   - One reader per metric code and dimension in `metrics_daily`; a
     reader's stale-row delete covers only the dimensions it writes. Which
     reader owns a code's total row is explicit (`writesTotal`), and two
     total writers for one code are refused by `assertRegistry`.
   - `net_sales` splits by `payment_method` (each order's net spread over
     its captured tenders with `allocateByWeight`, then the paid intent
     method, then `unassigned`) and by `menu_category` / `menu_item`
     (largest remainder per order). Sales owns every `net_sales` reader.
   - New source kinds: `share` (a split's summed value over the summed
     total, for `menu_popularity_pct`) and GL `balance` (all lines up to the
     bucket end, for `tax_payable`). A balance is a tenant figure only: by
     outlet, an outlet filter or an outlet scope answer
     `dimension_not_supported`, because the PBJT remittance journal may carry
     no outlet. A GL term may be limited to journal
     source types: `tax_collected` and `service_charge_collected` count
     only `sale` and `refund` journals (a reversal counts as the entry it
     reverses), so remittances and payouts do not reduce them.
   - `food_cost_pct` splits by splitting `cogs` and `net_sales` and
     dividing per split value; a split one side lacks is
     `dimension_not_supported`.
   - Multi-day `avg_serving_time` and `avg_dwell_minutes` are weighted by
     the catalog counts `served_ticket_count` and `closed_session_count`
     (`weightCode`); days without stored weight fall back to the plain
     mean until history is recomputed (legend-ka1hg).
   - A GL split is final only when every outlet with ledger lines has a
     final total row for every day of the bucket.
   - Dashboards: `managerRole` on the management query; tiles and queues
     carry `availability`; an unbuilt queue answers 200 with no rows and
     `source_not_built` instead of 501.

## 2026-11-10: WS-11: HPP per baris pesanan saat penjualan (legend-u4js6)

Konteks: `order_items.cost_snapshot_idr` (bigint, nullable) sudah ada tapi tidak
ada insert yang mengisinya. Pembacanya `ai-metrics/sales.ts` dan reader WS-11
F3 (`metric-sources/menu-cogs.ts`) sudah menganggapnya "HPP seluruh baris saat
terjual" dan NULL = tidak diketahui. Ditinjau architect sebelum implementasi
(tingkat K, uang).

1. **Nilai = HPP total baris** (jumlah x HPP per porsi), rupiah bulat. Resep
   satu baris diledakkan dengan jumlah sebenarnya (bukan 1 porsi dikali jumlah),
   lalu jumlah bahan (Decimal4) x `avg_cost_idr` (Decimal4) dijumlah dalam skala
   penuh dan dibulatkan **sekali per baris**, setengah ke atas, lewat
   `scaledCostToIdr` (`inventory-ops.shared.ts`). Tanpa pembulatan per bahan.
2. **Sumber biaya: `stock_balances.avg_cost_idr` di lokasi jual outlet
   (`outlet_inventory_settings.sale_location_id`) pada saat baris dimasukkan**,
   di transaksi yang sama. Alasan: kolom ini "HPP teoretis saat terjual"
   (PRD), ditulis sekali bersama barisnya, tanpa jalur tulis kedua dan tanpa
   menyentuh konsumen `order.paid` milik `recipe-deduction.service.ts`. Biaya
   deduksi (`recipe_deductions.cost_idr`) boleh berbeda: real_time memakai
   rata-rata saat lunas, day_close saat tutup hari, dan deduksi dibulatkan per
   pesanan, bukan per baris. Selisih itu (pergerakan harga rata-rata, pembulatan,
   baris NULL) masuk ke baris residual `__ledger_adjustment__` WS-11; itu yang
   diharapkan, bukan bug. `recipes.theoretical_cost_idr` tidak dipakai (belum
   pernah diisi, default 0).
3. **Varian dan modifier ikut**, dengan aturan yang sama dengan deduksi: resep
   varian, kalau tidak ada resep menu; modifier add-on dan aturan
   add/replace/remove. Pesanan delivery menyimpan `modifiers: []`, jadi modifier
   platform tidak dihitung (hanya resep dasar). Batas yang diketahui.
4. **NULL, bukan 0**, untuk baris yang: menunya tanpa resep; resepnya tidak aktif
   atau rusak; outletnya tanpa lokasi jual; jumlahnya kurang dari 1; resepnya
   meledak jadi nol bahan; atau satu saja bahannya tidak punya saldo di lokasi
   jual atau `avg_cost_idr` = 0. **Tidak ada nilai sebagian**: HPP sebagian
   terbaca sebagai margin palsu. Bahan yang memang gratis ikut jadi NULL;
   selisihnya tertampung di residual. Baris lain di pesanan yang sama tetap
   dihitung sendiri-sendiri.
5. **Edge `qr-order-applier.ts` menulis NULL, payload tidak diubah.** Pesanan
   itu dibuat di cloud oleh `qr-order.service.ts`, yang sudah menulis snapshot
   di barisnya; laporan membaca cloud, jadi tidak perlu pengisian ulang. Payload
   `qr_order.placed` adalah `z.strictObject`: menambah field membuat edge versi
   lama menolak event dan menahan semua pesanan QR. Master sync edge tidak
   membawa resep atau `stock_balances`. POS yang berjalan di edge memakai helper
   yang sama dan mendapat NULL bila data itu tidak ada. Bila nanti ada applier
   cloud untuk pesanan dari edge (legend-kai), applier itu memanggil helper ini
   di cloud saat menerapkan.
6. **Snapshot tidak pernah ditulis ulang.** Void, refund, koreksi, remake, comp
   dan fire hanya mengubah `status` atau `fire_status`; pembaca mengecualikan
   baris `voided`. Remake dan comp punya biaya sendiri di deduksinya. Replay
   edge memakai `onConflictDoNothing`.
7. **Kegagalan tidak menggagalkan pesanan.** Helper berjalan di savepoint
   (`tx.transaction(...)`, pola `openRefundChainSafely` di
   `payment-refund.service.ts`). Galat SQL tanpa savepoint membatalkan seluruh
   transaksi Postgres, jadi try/catch saja tidak cukup. Galat tak terduga: semua
   baris pesanan NULL, `logger.warn` dengan tenant, outlet, order id dan kode
   galat saja. Alasan NULL yang biasa (tanpa resep dan sebagainya) tidak dicatat
   ke log.
8. **Bentuk.** Berkas baru `apps/api/src/services/order-cost-snapshot.service.ts`:
   `computeLineCostSnapshots(tx, context, outletId, lines) -> Promise<(number |
null)[]>` (urutan sama dengan `lines`; baris =
   `{menuItemId, variantId, modifierIds, quantity}`). Nama tidak bentrok dengan
   `estimateDeductionCostIdr` (cabang KDS, yang mengembalikan 0, kontrak
   berbeda), dan tidak mengimpor dari `recipe-deduction.service.ts`. Satu
   pesanan memakai jumlah query tetap: lokasi jual (berhenti di sini bila
   kosong), satu ledakan per baris yang memuat data master sekali, satu baca
   saldo. Untuk itu `recipe-bom.service.ts` mendapat ekspor tambahan
   `explodeMenuLinesEach` (hasil per baris), dengan pemuatan data master dan
   konversi UOM diekstrak ke fungsi internal bersama; perilaku
   `explodeMenuLines` tidak berubah. Dipanggil tepat sebelum
   `insert(orderItems)` di `pos-order.service.ts`, `qr-order.service.ts` dan
   `delivery-inject.ts`. Tidak ada migrasi; slot 0183 dilepas.
9. **Tidak ada backfill dan tidak ada kartu bd untuk itu.** Mengisi baris lama
   dengan harga hari ini memalsukan "saat terjual". Baris lama tetap NULL dan
   tampil sebagai residual WS-11.

Tindak lanjut (legend-n8r5m, cabang `ws/cost-snapshot-edge`): DTO order POS
(`pos-order-support.ts`) tidak lagi memetakan NULL ke 0. HPP adalah data
finance (`inventory.cost.view`) sedangkan DTO POS bisa dibaca peran dengan
`order.view` saja, jadi DTO POS selalu mengirim `costSnapshotIdr: null` (tidak
diketahui / tidak ditampilkan); pembaca biaya memakai SQL. `ai-metrics/sales.ts`
masih menjumlah dengan `COALESCE` (HPP tak diketahui terbaca 0); berkas itu
milik alur WS-11 dan menunggu di sana.

Pesanan lewat edge: cloud tidak punya titik ingest `order_items` untuk pesanan
edge. Applier `qr_order.placed` hanya berjalan di edge (arah cloud_to_edge, baris
itu salinan dari pesanan cloud yang sudah ber-HPP) dan event `order.*` dari edge
hanya diparkir di `edge_deferred_events`. Pengisian HPP untuk pesanan POS edge
menunggu applier backfill (legend-078n).

10. **Shared round 3 (brief 284, 2026-11-10).**
    - Readers get the job's clock (`DailyComputeInput.now`) and never read
      the wall clock.
    - Finality hold: a reader may declare `pendingDay`; the job asks it
      before computing, and while it holds the reader's rows stay
      estimates. Delivery holds while an order of the day is
      `received`..`picked_up`; incident response holds while an incident of
      the day has no `responded_at`. Each sweep also revisits held days up
      to 90 days back, so a late end turns the day final and its value
      follows.
    - `keepFinal`: a reader whose inputs are configuration without history
      (facility operating hours) keeps its closed days as they are. Hours
      with an effective date are a follow-up (legend-4us1a).
    - Facility occupancy, unit utilization and incident response time are
      derived ratios over new stored sums, so multi-day values are weighted
      by volume.
    - `stock_value`, `purchase_total`, `supplier_due` and `delivery_sales`
      are owned by daily readers and are no longer listed as ledger gaps.
    - Training orders change no sales metric. Their sales journals are a
      separate bug (legend-gkc6b).
    - Mocks follow the registry: every family mock lists its unavailable
      metrics and a drift test pins the list to the registry.

## 2026-11-08: Worker event transport, acknowledgement and gap replay (legend-18qw)

Context: the production worker refused to start without an operator-supplied
transport module (`WORKER_TRANSPORT_MODULE`) and had no notification recipient
resolver or channel providers, so no outbox event was delivered in production.
Reviewed with an architect consult before implementation.

1. **No new HTTP ingest.** The authenticated edge/cloud ingest is the existing
   edge link `/api/edge-link` (legend-2pi): bearer credential checked against
   its stored hash, Origin header refused, re-verified every 30 s, revoked nodes
   closed with 4403. A second ingest path would duplicate that surface.
2. **Built-in transport** (`apps/api/src/worker/transport.ts`, selected with
   `WORKER_TRANSPORT=builtin`; the module overrides stay for operators):
   - Cloud: destination `cloud-sync` is a local sink. The in-process consumers
     already ran inside `consumeOutbox`; the `domain_event_consumptions` row
     (unique per consumer + event id) is the durable, idempotent
     acknowledgement, so a redelivered job is a no-op.
   - Edge (`EDGE_MODE=true`): `cloud-sync` events are queued `edge_to_cloud`
     with `enqueueEdgeEvent` on the consumption transaction (idempotent by
     event id, gap-free link sequence). The link's batch/ack/resend frames
     carry them; `edge_outbound_queue.status` + `sync_cursors.acked_out_seq`
     are the wire acknowledgement. This is the edge outbox drain the up-sync
     bead legend-kai mentions; legend-kai keeps the cloud-side applier,
     reconciliation and outage tests.
   - Any other destination, or a row with a non-null `direction`, throws: the
     job retries and then dead-letters (operator replay exists). Cloud-to-edge
     fan-out is not routed here: outbox sequences are per destination, not per
     edge node, and master-data versus transaction classification belongs to
     legend-97p.
3. **Gap replay.** An outbox sequence is allocated in the producer's own
   transaction, so a missing sequence is a producer bug that no peer can fill;
   wire-level gaps are already resent by the link. `requestMissing` records the
   gap in `domain_event_gap_requests` (unique per tenant, destination,
   aggregate and missing sequence; tenant RLS), counts repeats, logs
   `Outbox sequence gap` on the first request and each power of two, and the
   relay marks it resolved once the consumer offset passes it. The relay asks
   every tick, but a gap row is counted and rewritten at most once a minute
   (a resolved gap requested again is always reopened). Nothing skips a gap
   automatically; the aggregate stays held until the event arrives. An
   audited operator "skip gap" action would be a separate bead. A failure to
   write the gap record is logged and never aborts the relay tick.
4. **Producer bug fixed.** `operations-events.ts` numbered checklist events
   across destinations, so the `notification` alert of a started run got a
   sequence above 1 and was blocked forever. Sequences are now per
   destination, like the other allocators.
5. **Notifications fail closed at startup.** `NOTIFICATION_EMAIL_PROVIDER`,
   `NOTIFICATION_PUSH_PROVIDER` and `NOTIFICATION_WHATSAPP_PROVIDER` are
   required; `disabled` is an explicit value. A disabled channel is reported as
   unreachable to the delivery planner, so it is skipped, never reported as
   sent; in-app notifications are always written. Email has a Brevo adapter
   (account and sender domain: legend-wwuc); web push and WhatsApp templates
   stay `disabled` until legend-hyq. Only Brevo 400 and 422 decline a
   message for good; every other failure (401, 403, 404, 408, 429, 5xx,
   network) throws, is retried and is logged with the channel and HTTP status
   only (never the body, the address or the key). `BREVO_API_KEY` must be
   printable ASCII without spaces and `NOTIFICATION_EMAIL_FROM` must not be a
   placeholder (`.invalid`, `replace_me`); both are checked at startup.
6. **Recipients come from server state only**, by event name:
   `approval.requested` goes to holders of the current level's approver roles
   whose assignment covers the outlet (requester excluded);
   `approval.resolved` to the requester; `support_access.*` to tenant admins
   (`org.settings.manage` on a tenant-wide assignment); checklist missed and
   failed alerts to the outlet's `supervisor`/`outlet_manager` roles, falling
   back to the tenant owner. An event without a rule throws, so it is retried
   and dead-lettered instead of dropped silently. Banned (disabled) or missing
   accounts are dropped from every audience before a fallback is chosen (a
   banned supervisor does not hide the owner fallback) and unreachable at send
   time; an account whose `ban_expires` has passed counts as active again.
   `approval.resolved` reaches the requester only while they still hold an
   active assignment in the tenant. A malformed stored preference falls back
   to the defaults for that user only.
7. **Email is at-least-once, deduplicated within Brevo's window.** Every send
   carries `headers.idempotencyKey`, a UUID derived from the delivery
   attempt's stable reference, so a retry of the same attempt (lost response,
   worker crash) reuses the key. Brevo processes a key once for 30 minutes and
   answers a reuse with error code `duplicate_parameter` (status undocumented,
   so any 4xx carrying it counts), which the adapter treats as the
   acknowledgement. A retry later than 30 minutes after an accepted send whose
   response was lost can still deliver a second copy; with the default retry
   table (30 s, 2 min, 10 min, 1 h; tenant policy may change it) only the
   last retry falls outside the window. A duplicate notification email is accepted as the lesser failure
   compared with a lost one.

## WS-07: purchase return and petty purchase journals (legend-1xbs, legend-v3lh)

Decided 10 Nov 2026 (architect, tier K money). Design brief: `docs/briefs/298a-sub-purchase-return-posting-design.md`.

1. **Return payload carries the split.** `purchase_return.recorded` adds
   `outletId`, `uninvoicedValueIdr`, `invoicedValueIdr` and `ppnIdr`;
   `valueIdr = uninvoicedValueIdr + invoicedValueIdr`, and `ppnIdr > 0` only
   when `invoicedValueIdr > 0`. A split (not one flag) keeps a mixed return
   balanced. The emitter sums per-line rounded values; it never prorates the
   total.
2. **Return journal.** Dr `grni` for the uninvoiced part (receipt not yet
   billed), Dr `accounts_payable` for the invoiced part plus PPN (debit note),
   Cr `inventory` for `valueIdr`, Cr `ppn_input` for `ppnIdr`. A return with
   `valueIdr = 0` posts nothing.
3. **Petty purchase** is an expense, never stock (the contract says it is not
   a stock document, so debiting `inventory` would break the GL to stock
   ledger tie). New event `petty_purchase.recorded` (id-only payload), new role
   `petty_purchase_expense`, default account `5104 Pembelian Langsung (Kas
   Kecil)` (tenant can remap). Credit goes to `petty_cash` (1102), not
   `cash_on_hand` (1101 is the POS drawer, settled at shift close). This
   overrides the card text "kredit kas". No PPN input on petty purchases.
4. **New journal source types** `purchase_return` and `petty_purchase`
   (check constraint widened in migration 0205, which also backfills 5104).
5. **Goods receipt is NOT posted here.** `goods_receipt.recorded` has a rule
   but no consumer yet (legend-29vw). A return that debits GRNI is only
   correct once receipts credit GRNI, so legend-29vw must ship before the
   purchase return emitter goes live. No emitter exists today, so nothing
   posts and no balance drifts.
6. **Known gaps (follow-up beads):** a debit note reduces AP in the ledger but
   creates no AP open item; invoice-vs-receipt price differences on returns;
   receipts recorded before go-live need a finance cutover entry; no PPN input
   on petty purchases; `supplier_invoice.recorded` still unposted.

## WS-06: supplier return and petty purchase backend (legend-65mgw)

Decided 10 Nov 2026 (architect, tier K). Design: `docs/briefs/301b-sub-return-petty-design.md`.

1. **Return gate.** `PURCHASE_RETURN_POSTING_ENABLED` (env, default off). While off the whole `POST /api/inventory/purchase-returns` is refused with 403 `FEATURE_DISABLED` before the idempotency claim: a stock-out without a GRNI journal would split the GL from stock. Reads stay open. `legend-29vw` (goods receipt journal) turns it on and adds a cutover guard.
2. **Return value.** Stock leaves at the receipt cost, not the moving average, so GRNI clears exactly. Each line books the cumulative rounded value minus earlier returns; `valueIdr` is the sum of line values. Split is `uninvoiced = valueIdr`, `invoiced = 0`, `ppn = 0` until supplier invoices exist.
3. **Over-return race.** Returns of one receipt are serialised by a row lock on the receipt's purchase order (`legend_app` has no UPDATE on `goods_receipts`, so locking the receipt fails). Own location lock and balance check give `INSUFFICIENT_STOCK` because the stock ledger allows negative balances.
4. **Petty purchase** is rejected, not approved, when over the limit or when no policy exists (409 `PETTY_PURCHASE_LIMIT_EXCEEDED`). Photo is mandatory, stored in `core_storage_objects` with source kind `petty_purchase`, linked once. Business date is the outlet business date; no back-dating. Policy writes: `PUT /api/inventory/petty-purchase-policy`, permission `purchasing.petty_policy.manage` (owner, finance).
5. **Permissions:** `purchasing.return.create` (owner, purchasing, warehouse), `purchasing.petty.record` (owner, general_manager, outlet_manager, kitchen_lead, purchasing), `purchasing.petty_policy.manage` (owner, finance).
6. **Known gaps (beads):** moving average not re-averaged on return; petty limit is per transaction only (daily cap bead); invoiced debit notes need AP open items (`legend-179bw`); batch returns from another location than received give a generic 422.

## WS-08: loyalty points journal, PSAK 72 (legend-msqvi)

Decided 10 Nov 2026 (architect, tier K money). Status: proposed. Needs the founder accountant (Q7) and a Codex second opinion (xhigh) before release. Design: `docs/briefs/sub-304c-arch-decision.md`; slices: `docs/briefs/sub-304c-points-journal.md`.

1. **Policy.** Points are a material right, a separate performance obligation. Earn defers the fair value of the points: points x Rp100 (Q68) x expected redemption rate. The rate stays at **100%** in v1 (no history yet), so no breakage is estimated up front; breakage is recognised only at `points.expired`. A rate below 100% needs the rate stored per ledger row (migration) plus breakage-pattern recognition, so it can never change silently. IAI renumbered PSAK 72 as PSAK 115 from 2024 (same content as IFRS 15); a private entity may report under SAK EP. Q7: the accountant confirms which standard applies **before the journal is enabled**.
2. **Allocation at face value.** Earn is 1 point per Rp10.000 and 1 point = Rp100, so the deferral is 1.00% of the sale; relative standalone selling price would be 0.990%. The gap is about 1% of the deferral, immaterial. Q7 confirms. Bonus points (mission, referral, birthday) are consideration payable to the customer (PSAK 72 para 70) and also reduce revenue; referral points could instead be marketing expense (Q7 decides).
3. **Accounts.** New role `loyalty_points_deferral` (type revenue), seed account `4105 Penangguhan Pendapatan Poin Loyalty`, parent 4100, a contra-revenue account. Existing: `loyalty_liability` 2105, `loyalty_breakage_revenue` 4104. `sales_revenue` 4101 stays equal to gross POS sales. `sales_discount` 4103 is not used for redemptions (this replaces the 290f design): a free item fulfilled without an order would leave 4103 with a credit balance, and a voucher used on an order already debits 4103 through `order.paid` `discountIdr`. 4105 net = earned - redeemed. No migration: roles are varchar without a CHECK and `'loyalty'` is already in the `source_type` check. If code 4105 is taken by another account the backfill skips it and posting parks retryable `ACCOUNT_MAPPING_MISSING`.
4. **Entries.** Amount is the signed `liability_idr` of the `point_ledger` row (the row is the authority, never the payload).
   - `points.earned`: Dr 4105, Cr 2105.
   - `points.reversed` (refund, void): Dr 2105, Cr 4105, exact mirror of the reversed amount.
   - `points.redeemed`: Dr 2105, Cr 4105.
   - `points.adjusted`: one rule, Dr 4105, Cr 2105, `pointsValueIdr` signed; a negative amount flips the sides. Restore mirrors the redeem; manual + and - both use it.
   - `points.expired`: Dr 2105, Cr 4104.
     The old `points.earned` rule (Dr `sales_revenue`) was never wired and is replaced.
5. **Recognition at redeem.** Recognition happens at `points.redeemed`, when points become a voucher or free item. Only ledger rows with `source_type = 'reward_redemption'` are journaled; other redeem rows are ignored. Points tender stays refused, and if it ships it needs a distinct `source_type`, because the sale journal already moves 2105 through `paidPointsIdr` / `refundPointsIdr` (both 0 today). A pin test covers this, so there is no double count with `order.paid` / `order.refunded`.
6. **Idempotency, no payload change (engineer override).** `events.ts` and `point-ledger.service.ts` are not changed (the architect proposed an additive `ledgerEntryId`). The ledger entry id comes from the envelope: `event.idempotencyKey` is `"<event name>:<ledgerEntryId>"`, parsed after the first `:`. Missing or unparseable key, or ledger row not found for the tenant: park `AUTO_JOURNAL_PAYLOAD_INVALID`. Journal key `aj:loyalty:<ledgerEntryId>`, `source_type = 'loyalty'`, `source_id` = ledger id; same advisory lock, lookup-first, savepoint and park path as other auto-journal events. One ledger row = one journal.
7. **Guards.** Gate on accounting enabled only, not on `loyalty_programs.is_active`: switching a program off would strand the liability on later expire, redeem and reverse events. Training orders: `points.earned` with an order source is skipped when `isTrainingOrder(sourceId)`; `points.reversed` checks the order of the reversed earn row.
8. **Legal entity and outlet.** Points events have no outlet and `auto_journal_parked.outlet_id` is NOT NULL, so v1 supports only a tenant with exactly one legal entity; all loyalty journals post there. Journal outlet: ledger outlet for earn, reversed row's outlet for reverse, else null (entity level). Business date comes from the ledger `created_at` with the oldest outlet of that entity as clock anchor, also used for parking. More than one entity parks non-retryable `LOYALTY_LEGAL_ENTITY_AMBIGUOUS`. Follow-up: `loyalty_programs.legal_entity_id` (needs migration 0212).
9. **Known gaps.**
   - Redemptions still pending at period end (`redemptionValidDays`, default 30, max 365) are recognised early; the `points.adjusted` restore reverses it on cancel or expiry.
   - `loyalty-earn-consumer.ts` does not skip training orders, so training orders award real points (`legend-kbbma`, must ship before the journal is enabled: their later redeem or expiry would post real revenue).
   - A `bonus` row with `source_type` `adjustment` emits no event and is never journaled; positive manual adjustments must use type `adjust` (no producer today).
   - Accounting switched on after points already exist pushes 2105 into a debit balance on redeem and expire; finance must post an opening balance for 2105.
   - Multi-entity tenants are parked until the follow-up card (`legend-6m1w1`: `loyalty_programs.legal_entity_id` plus an unpark path; parking is non-retryable and closed outlets count today).
10. **Release steps.** Existing tenants get 4105 and its mapping only through `pnpm db:backfill-defaults` (new tenants get it from the template). Until the backfill runs, points events park retryable `ACCOUNT_MAPPING_MISSING` and post on the next sweep. Journals are dated by the ledger `business_date` when the row has one (earn copies the order business date), else by the anchor outlet clock.

## 302 gateway registry (legend-l9rji, legend-pa21), 10 Nov 2026

Architect design, tier K. Full text with reasons and slice split: `docs/briefs/sub-302-design.md`. Decisions D1-D27 copied below.

## 1. Registry (`services/payment-gateway.ts`)

D1. Registry API. `const registry = new Map<string, PaymentGatewayPort>()` plus:
- `registerPaymentGateway(port)`: adds/replaces `port.provider`; clears legacy mode.
- `paymentGatewayFor(provider: string): PaymentGatewayPort`: registered port, else `unconfiguredPaymentGateway` (fail closed).
- `registeredGatewayProviders(): readonly string[]`.
- `resetPaymentGateways()` (tests).
- Optional port method `testConnection?(context, integrationId): Promise<{ ok: true; methods: readonly GatewayMethodAvailability[] } | { ok: false; code: "GATEWAY_AUTH_FAILED" | "GATEWAY_UNREACHABLE" | "GATEWAY_REJECTED" }>`.
- `GatewayCancelRequest` gains `provider: string`.
Reason: one adapter per provider; callers say which provider.

D2. Compat shim, test only. Keep `setPaymentGateway(port | null)`: clears the registry, registers `port` and turns on legacy mode. In legacy mode `paymentGatewayFor(anything)` returns that port and `registeredGatewayProviders()` returns `[port.provider]`. This reproduces today's singleton exactly (doubles use `provider: "doit"|"pjp"|"x"...`, intents store the routing provider), so the 44 test files stay unchanged. DELETE `paymentGateway()`: typecheck then forces every production call site below to migrate. `server.ts`/`worker-main.ts` must call `registerPaymentGateway`, never `setPaymentGateway` (reviewer greps).

D3. Boot (`server.ts:44-46`, `worker-main.ts:149-151`): `registerPaymentGateway(doitGateway)`; `registerPaymentGateway(createDuitkuGateway({...}))` always (an unconfigured tenant reads `down/unconfigured`). Refund: `registerPaymentRefundGateway(doitGateway)` only if `env.DOIT_REFUNDS_ENABLED`; no Duitku refund port.

D4. Provider selection, new module `services/payment-gateway-select.ts` (keeps `payment.service.ts` edits to call swaps):
- `selectGatewayForNewIntent(context, outletId, routing: ResolvedRouting): Promise<{ provider, port, health } | { provider: null, health }>`: candidates = [routing.provider, routing.fallbackProvider] (non-null, distinct). A candidate is usable when `isPlatformGatewayEnabled(provider)` (D9) and `paymentGatewayFor(p).health(ctx, outletId).status !== "down"`. First usable wins (Q73: fallback only when primary is down or platform-disabled). None usable: return primary's health (so `unconfigured` stays non-incident).
- `outletGatewayHealth(context, outletId): Promise<GatewayHealth & { provider: string }>`: providers = distinct primary+fallback of the outlet's ENABLED rules for `qris`,`va`,`bank_transfer` (resolveRoutingRule). Status = best of the readings (up > degraded > down); `reason: "unconfigured"` only if every reading is down+unconfigured. `provider` = providers joined with `+` (audit only). Health calls run in parallel.
- Tenant-allowed (feature flags) is checked at rule write (D12) AND at intent time (legend-8zy5f, 10 Nov 2026): `selectGatewayForNewIntent` and `outletGatewayHealth` drop a candidate the tenant's package no longer lists, so a revoked gateway falls to the fallback or answers 503; existing intents stay put (PAY-05). The PRD default (no stored rule) is gated only when the package lists some payment gateway but not DOIT; a legacy tenant listing no gateway keeps the default. Legacy test mode skips the check.

D5. Call sites (all verified at base):
- `payment.service.ts:367` `onlineMethods`: per method use `selectGatewayForNewIntent`; channels from the selected port; `provider` in the view = selected provider (fallback when used). `unavailableReason` unchanged semantics.
- `:403` `getPaymentLinkView`: health = `outletGatewayHealth` (feeds failover).
- `:555` `readIntentPlan`: return the whole `ResolvedRouting` (`routing`) instead of only `provider`; existing-idempotent branch unchanged (returns `existing.provider`).
- `:652` `createIntentCore`: `selectGatewayForNewIntent`; none usable -> same 503 + failover as today (sync with `outletGatewayHealth`). Store `provider: selected.provider` on the intent and pass it in `GatewayIntentRequest.provider`. Never re-route an existing intent.
- `:711` `cancelSupersededAtGateway`: `paymentGatewayFor(intent.provider).cancel?.(...)`; `supersedePending` fills `provider: row.provider`.
- `:1240` `syncPendingIntentDetailed`, `:2040` `syncExpiredIntentPayment`: `paymentGatewayFor(intent.provider)` (PAY-05; ignores platform enabled flag: money in flight).
- `:1931` `expireDueIntents`: `gatewayOwned = and(isNotNull(providerRef), inArray(provider, registeredGatewayProviders()))`; empty list -> `sql\`false\``.
- `:2215` `pollPendingGatewayIntents`: `inArray(paymentIntents.provider, registeredGatewayProviders())` (empty -> return `{checked:0, settled:0}` before the claim). Error budget per provider: `Map<provider, consecutiveErrors>`; a provider at 3 is skipped with `continue` placed BEFORE `checked += 1` (with one provider this equals today's `break`). One down gateway never stops the other's poll.
- `qr-order-payment.ts:239,279`: same as `onlineMethods` (per-method selection; VA banks from the selected port).
- `reservation-deposit-payment.ts:44`: replace the `provider === "unconfigured"` + health check with `selectGatewayForNewIntent` for the method the deposit uses (verify in impl which method; likely qris), fail closed when `provider === null`.
- `payment-failover.service.ts:206` `writeIncidentRow`: `provider` comes from a new `provider` input field (from `outletGatewayHealth().provider`); `syncGatewayHealth` signature gains optional `provider?: string` (default `"unknown"`). `:430` `probeGatewayHealth` and `worker/payment-failover-probe.job.ts:73`: use `outletGatewayHealth`. Incident stays per outlet and means "no online gateway usable for this outlet" (cashier failover only when primary AND fallback are down).
- `payment-admin-config.service.ts:217,273`: see D12-D13.

D6. Refund per provider. `payment-refund-gateway.ts`: registry like D1 (`registerPaymentRefundGateway`, `paymentRefundGatewayFor(provider)`, keep `setPaymentRefundGateway` as the same legacy shim, delete `paymentRefundGateway()`). `payment-refund.service.ts`: `refundGatewayInstalled()` becomes `refundGatewayInstalled(provider)`; call sites 1404, 1406, 1752, 1997, 2269, 2480, 2566 pass the provider of the refunded payment (from the claim's intent/evidence row: `paymentIntents.provider`, verify in impl which row each site already has). Duitku has no refund API: its refunds stay `approved` and finance closes them with the existing `settleRefundManually` (2880). No new path. New bead: "Duitku refund API / manual payout runbook".

## 2. Platform gateway config (Super Admin)

D7. New global table `platform_payment_gateways` (not tenant data, so not in `tenants.feature_flags`, and `platform_packages` is per package not per gateway):
`provider varchar(20) PK CHECK (provider IN ('doit','duitku'))`, `display_name varchar(60) not null`, `enabled boolean not null default false`, `is_default boolean not null default false`, `webhook_tolerance_past_sec integer not null default 90000` (25 h), `webhook_tolerance_future_sec integer not null default 300`, `secret_grace_hours integer not null default 72`, `updated_by text null`, `updated_at timestamptz not null default now()`. `CHECK (NOT is_default OR enabled)`, partial unique index `platform_payment_gateways_one_default ON (is_default) WHERE is_default`. Seed in the migration: `('doit','DOIT',true,true)`, `('duitku','Duitku',false,false)`.

D8. Default gateway for new tenants. `platform-org.service.ts createTenant` (same tx, verify it can write tenant rows there): if `input.featureFlags.integrationProviders` has no payment-gateway provider, append the platform default; then insert tenant-wide `payment_routing_rules` for `qris`,`va`,`bank_transfer` with `provider = default, fallback null, enabled true`. Changing the default later never touches existing tenants (rule-less legacy tenants keep `defaultRouting` = doit). Reason: changing the default must not move an existing brand's money (PAY-05).

D9. Reader `services/platform-payment-gateway.service.ts` (process cache 30 s, reset fn for tests):
`listPlatformGateways()`, `getPlatformGateway(provider)`, `isPlatformGatewayEnabled(provider): Promise<boolean>` (missing row -> false, except legacy mode -> true so old tests pass), `platformDefaultGateway(): Promise<string|null>`, `gatewayWebhookTolerance(provider): Promise<{ pastMs, futureMs }>` (missing -> 25 h / 5 min), `gatewaySecretGraceMs(provider)` (missing -> 72 h), `updatePlatformGateway(provider, input, actorUserId)`.

D10. Super Admin API (contract `packages/shared/src/platform/payment-gateways.ts`, export from the platform index):
- `GET /api/platform/payment-gateways` -> `{ data: PlatformGateway[] }`.
- `PUT /api/platform/payment-gateways/:provider` body `{ enabled, isDefault, webhookTolerancePastSec (60..172800), webhookToleranceFutureSec (0..3600), secretGraceHours (1..720), reason (1..500) }`, strict.
- Guards exactly like `platform.routes.ts`: `requireAuth, requireTrustedOrigin, requirePlatformAdmin, requireSessionMfa()` plus permission `platform.integration.manage` (mirror how platform.routes checks a platform permission, verify in impl).
- Rules: `isDefault:true` clears the old default in the same tx (advisory lock); disabling the default is refused (`422 GATEWAY_IS_DEFAULT`); `enabled:true` requires a registered adapter.
- Audit `platform.payment_gateway_updated`, before/after of the non-secret columns + reason. Use the platform-level audit mechanism used by platform package writes (verify in impl; if `recordAudit` needs a tenant, follow the platform package pattern).

D11. Disabling a gateway blocks only new things: new rules (D12), new intents (D4 treats it as down, so fallback or cashier), test-connection still allowed. It never blocks: getStatus, poller, webhook, cancel, refund lookup of existing intents (they resolve by `intent.provider` through the registry, which keeps the adapter). Stored rules naming it are not rewritten; the routing view shows it with `enabled:false`.

## 3. Tenant side

D12. Routing write validation, one helper `assertRoutableProvider(tx, ctx, provider, outletId|null)` in `payment-routing.service.ts`, used by `updatePaymentRoute` (`payment-admin-config.service.ts:259`) and `upsertRoutingRule` (`:171`). Only when the rule is `enabled:true`. Checks, error `422 VALIDATION_ERROR` code text "GATEWAY_NOT_AVAILABLE":
(a) registered adapter; (b) platform enabled; (c) tenant `featureFlags.integrationProviders` includes it (reuse `isIntegrationProviderAvailable`, fail closed); (d) an active `tenant_integrations` row: outlet rule -> `resolveIntegration(rows, provider, outletId)` non-null; tenant rule -> an active tenant-wide row OR at least one active outlet row.
Fallback: null, or `!== provider` and passes (a)-(d). Remove the "No second gateway" refusal and the `!== paymentGateway().provider` check (`:273-281`).

D13. Routing view providers (`:217`): registered ∩ platform enabled ∩ tenant-allowed, `name` = platform `display_name`, `enabled` = (d) for the requested scope. Contract `paymentProviderSchema` unchanged.

D14. Permission: routing GET/PUT move from `payment.edc.manage` to `org.settings.manage` (brief §Tujuan 3; `payment-routing.service.ts` header already says so). `payment-admin.routes.ts`: new `settingsQuery/settingsBody = byOutlet("org.settings.manage", ...)` for the two routing routes; service `authorize` takes the permission as a parameter. Holders: owner (all), tenant_admin. UI nav lists only `payment.edc.manage` etc.: new UI bead to add `org.settings.manage` to `PAYMENT_ADMIN_PERMISSIONS`/nav (do not edit web). Existing routing tests may use an edc-only actor: verify `test/http.test.ts`, `public-rate-limit.test.ts`.

D15. Credentials: reuse `PUT /api/org/integrations` (`org.integration.manage`). Per-provider spec in `packages/shared/src/platform/integrations.ts`: `GATEWAY_CREDENTIAL_SPECS = { doit: {...today}, duitku: { credentials: ["merchantCode","apiKey"], config: { environment: "sandbox"|"production" (required), notificationEmail (required email, sent to Duitku as `email`), vaName (optional, <=20) } } }`. `upsertIntegration` refuses a duitku body that misses a field or sends an unknown or `previous*` credential key (`VALIDATION_ERROR`, field names only). merchantCode sits in credentials (paired with its key for rotation; not echoed either).

D16. Test connection: `POST /api/org/integrations/:integrationId/test` (tenantGuard, `org.integration.manage`, no body). Service `testGatewayConnection(ctx, integrationId, actor)` in new `services/payment-gateway-connection.service.ts`: row in scope (assertRowInScope rules), provider category `payment_gateway`, adapter has `testConnection` else `422 NOT_SUPPORTED`. Works for `draft` rows. Writes `last_checked_at`, `last_error_code` (null on ok), audit `integration.connection_tested` `{ ok, errorCode }`. Response `{ data: { ok, checkedAt, errorCode, methods: [{ method, enabled, channelCount }] } }`. Duitku: getpaymentmethod with amount 10000 and current WIB datetime; `00` -> ok. Never return/log apiKey, signature, raw provider body.

## 4. Secret rotation and time windows (asumsi 1, 2)

D17. Previous secret lives INSIDE the sealed credentials JSON (no new column): when `upsertIntegration` replaces credentials of a payment-gateway row and the rotating field changed (doit `webhookSecret`; duitku `apiKey` or `merchantCode`), the new sealed blob = new client fields + `previousWebhookSecret` (doit) / `previousMerchantCode`,`previousApiKey` (duitku) + `previousValidUntil` (ISO, now + `gatewaySecretGraceMs`). Only one previous generation. `credential_fields` lists client fields only. Audit `integration.credentials_rotated` `{ provider, previousValidUntil }` in the same tx. `rotateIntegrationCredentials` (`:591`) re-seals: it must carry the previous* keys through unchanged (verify in impl what it does).
D18. Verification accepts current, plus previous while `now < previousValidUntil`. DOIT: `cachedWebhookSecrets` adds a previous entry; `signedByIntentIntegration` accepts `previousWebhookSecret` too. Duitku: `verifyDuitkuCallback({ creds: [current, previous?] })`. Outbound calls (inquiry, status) always use current. Exception: getStatus for an intent minted with the previous merchantCode (verify: if `transactionStatus` answers unknown with current, retry once with previous while in grace).
D19. Time window per gateway: `verifyDoitSignature` takes `tolerance` from `gatewayWebhookTolerance("doit")` instead of the constant `DOIT_SIGNATURE_TOLERANCE` (keep constant as default). Duitku callback has no timestamp: no window; replay safety = dedupe + D21 status confirmation.

## 5. Late payment (asumsi 3)

D20. The existing path is provider-agnostic: `applyConfirmation` / `confirmPayment` (`payment.service.ts:1445`) on a `failed`/`expired` intent flags late payment / `recordUnsettledGatewayFunds` (`:1100`, keyed by `payment_evidence (tenant, provider, provider_ref)`, so one row), using `intent.provider`. No code change; Duitku only has to call `confirmPayment` with `provider: "duitku"` evidence and the Duitku `reference` as providerRef. Tests (Duitku, fail first): expired intent then verified paid callback -> unallocated/late, bill paid once; failed (status 02) then paid -> same; poller `syncExpiredIntentPayment` with a Duitku double -> same single row.

## 6. Duitku webhook

D21. Route `POST /api/webhooks/payments/duitku/:tenantId` in `routes/payment-webhook.routes.ts` (router mounted at `/api/webhooks/payments`, DOIT at `:122`). Body: `express.raw({ type: "application/x-www-form-urlencoded", limit: "16kb" })`, parsed with `URLSearchParams`; a repeated key -> reject. Reuse the failed-verification per-IP limiter. Answer `200 "OK"` for stored/duplicate, `401` for rejected, `503` for DB error (Duitku retries).
D22. New `services/payment-duitku-webhook.service.ts` (do not generalise `payment-webhook.service.ts`, it is DOIT-shaped): `receiveDuitkuCallback({ tenantId, rawBody, now })`:
1. tenant id + active check (export `tenantIsActive`/`tenantWideContext` from payment-webhook.service.ts or copy the 10-line query; Slice D owns both files).
2. `parseDuitkuCallback`; `merchantOrderId` must be a uuid = intent id; load intent in tenant; missing or `provider !== "duitku"` -> rejected.
3. creds from `loadIntegrationCredentialsById(ctx, "duitku", intent.gatewayIntegrationId)` (works when disabled), + previous (D18).
4. `verifyDuitkuCallback({ creds, fields, expectedAmountIdr: intent.amountIdr })`. `bad_signature`/`wrong_merchant`/`bad_amount` -> rejected row (unique tenant+payload_hash), 401, no state change. `amount_mismatch` -> store as valid but never confirm the callback amount (step 6 decides).
5. Store `gateway_webhook_events` row: provider `duitku`, `event_id = merchantOrderId + ":" + (reference ?? "-") + ":" + resultCode`, `provider_ref = reference`, integration id, payload = parsed fields. Unique conflict -> `duplicate`, 200.
6. Process: IGNORE resultCode (unsigned). Always call `duitkuTransactionStatus` with the minting creds. `00` + amount -> `confirmPayment` (source verified_webhook, amount = status amount, providerRef = intent.providerRef; mismatch -> existing AMOUNT_MISMATCH -> unallocated). `01` -> row `failed` code `PENDING_AT_PROVIDER` (retried). `02` -> `applyGatewayFailure(expired if now >= expiresAt else failed)`. Status error -> row `failed`, retried.
7. `reprocessDuitkuWebhookEvents(ctx, now)` (24 h window, like `WEBHOOK_RETRY_WINDOW_MS`), called from `worker/payment-gateway-poll.job.ts` next to the DOIT reprocess.

## 7. Duitku adapter (`services/payment-duitku.ts`, `createDuitkuGateway({ fetch?, now?, callbackBaseUrl, returnUrl })`)

D23. merchantOrderId = intentId (uuid, 36 <= 50). paymentAmount = `amountIdr` integer. `expiryPeriod` = max(1, ceil((expiresAt - now)/60000)) minutes. productDetails = "Pembayaran " + intentId prefix (<=255, no PII). email = config.notificationEmail; customerVaName = config.vaName ?? "Legend" (<=20). callbackUrl = `${callbackBaseUrl}/api/webhooks/payments/duitku/${tenantId}`; returnUrl from env.
D24. Methods: `methods(ctx, outlet)` = getpaymentmethod (amount 10000, cache 60 s per integration id) grouped by `duitkuMethodCategory`: qris, va, ewallet, card -> `GatewayPaymentMethod`; `bank_transfer` always `enabled:false`; retail/paylater/other dropped. `channels(va)` = enabled VA codes as `PaymentChannel` (code = Duitku code, name = paymentName; verify PaymentChannel shape). createIntent: qris -> first enabled qris code from a fresh getpaymentmethod at the real amount; va/ewallet/card -> `channelCode` must be an enabled code of that category, else `CoreError VALIDATION_ERROR`. Guest screen stays qris/va/bank_transfer in this card (ewallet/card on guest screen: UI bead).
D25. providerRef = Duitku `reference`; instructions: qris -> qrString, va -> vaNumber + bank, others -> paymentUrl (verify `PaymentInstructions` variants). `integrationId` returned. `getStatus` requires `intentId` (merchantOrderId); checks the answer's reference === providerRef else gateway error; `00` -> paid (amount), `01` -> pending, `02` -> expired. `paidAt` null. `health`: no active integration -> `{down, unconfigured}`; else cached getpaymentmethod ok -> up, error -> down. No `cancel`. `testConnection` per D16.
D26. env (`config/env.ts`, `.env.example` empty): `DUITKU_CALLBACK_BASE_URL` (public API origin, https in production), `DUITKU_RETURN_URL`. Sandbox/production comes from integration config, not env. Founder keys for sandbox: merchantCode, apiKey (entered in the app, not env).

## 8. Migration 0211

D27. One migration `0211_platform_payment_gateways`, `when` 1794290000000 (journal at base ends 0208/1794287000000; 0209-0210 belong to other branches, merge train re-checks prevId). Contents: create table D7, check constraints, partial unique index, seed INSERT appended by hand after `pnpm db:generate` (second generate must be empty). Also verify in impl that `payment_intents.provider` and `payment_evidence.provider` have no CHECK excluding `duitku`; if they do, widen it in 0211. RLS: none (global, non-secret, no tenant column); mirror `platform_packages` grants/RLS exactly (verify `db/schema/platform-packages.ts` + its migration). Tenant request paths only SELECT it.

## 9. Slices (no shared files)

- A Registry + call sites: `services/payment-gateway.ts`, new `services/payment-gateway-select.ts`, `services/payment.service.ts`, `services/qr-order-payment.ts`, `services/reservation-deposit-payment.ts`, `services/payment-failover.service.ts`, `worker/payment-failover-probe.job.ts`, `services/payment-refund-gateway.ts`, `services/payment-refund.service.ts`, `server.ts`, `worker-main.ts`. Tests new `test/payment-gateway-registry.test.ts`: switching the rule keeps the old intent on its gateway (getStatus/poll hit origin port); fallback used when primary `down`; fallback skipped when primary up; platform-disabled primary -> fallback; poller polls both providers and one provider's 3 errors do not stop the other; Duitku refund stays approved (manual). Re-run: payment-api, payment-failover, payment-failover-tenants, payment-poll-lease, qr-order-late-payment, pos-order-late-payment, payment-doit-get-payment, services/payment-lifecycle.test.ts. Codes against D9 signatures (stub until B lands).
- B Platform config + routing rules: `db/schema/platform-payment-gateways.ts`, `db/schema/index.ts`, `drizzle/0211_*`, `drizzle/meta/*`, `services/platform-payment-gateway.service.ts`, new `routes/platform-payment-gateways.routes.ts`, `routes/index.ts`, `packages/shared/src/platform/payment-gateways.ts` + platform index export, `services/payment-routing.service.ts`, `services/payment-admin-config.service.ts`, `routes/payment-admin.routes.ts`, `services/platform-org.service.ts`. Tests new `test/platform-payment-gateways.test.ts` (Super Admin only + MFA, audit, one default, cannot disable default) and `test/payment-routing-gateway-choice.test.ts` (rule to a platform-disabled gateway refused; tenant not allowed refused; no active integration refused; fallback == provider refused; outlet A rule cannot use outlet B's integration; tenant B isolation; `org.settings.manage` required; new tenant gets default rules).
- C Duitku adapter: new `services/payment-duitku.ts`, `config/env.ts`, `.env.example`. Tests new `test/payment-duitku-adapter.test.ts` (mock fetch: inquiry body/signature, expiryPeriod, method mapping from getpaymentmethod, unconfigured -> down, status mapping + reference check, sandbox vs production URL from config, thrown errors contain no apiKey).
- D Webhooks: `routes/payment-webhook.routes.ts`, new `services/payment-duitku-webhook.service.ts`, `services/payment-webhook.service.ts` (DOIT previous secret + tolerance + exports), `services/payment-doit-wire.ts`, `worker/payment-gateway-poll.job.ts`. Tests new `test/payment-duitku-webhook.test.ts` (bad signature -> 401 not paid; amount differs -> not paid; resultCode 00 but status 01 -> not paid; duplicate -> once; cross-tenant id -> rejected; previous key accepted in grace, refused after; late payment cases D20) and `test/payment-doit-webhook-rotation.test.ts`; re-run payment-webhook-api, -limiter, -retry-integration, -rls, payment-doit-refund-webhook.
- E Credentials + test connection: `services/platform-integration.service.ts`, `routes/platform-integrations.routes.ts`, `packages/shared/src/platform/integrations.ts`, new `services/payment-gateway-connection.service.ts`. Tests new `test/platform-integration-gateway.test.ts` (duitku field validation; rotation stores previous + grace + audit; list/upsert/test responses and captured logs never contain apiKey/merchantCode values; outlet-scoped caller cannot test tenant row).
Order: A, B, C, E in parallel; D after C (needs `payment-duitku.ts` cred helper `duitkuCredentialSet(loaded, now): DuitkuCredentials[]`, exported by C). A and B meet only via D9 signatures.

## 10. Risks
- Package downgrade (legend-8zy5f): rules naming a removed gateway are not rewritten but are skipped at intent time (D4). Residual: a legacy rule-less tenant whose package lists no gateway keeps DOIT by default.
- Legacy shim (D2) is a catch-all; production must never call `setPaymentGateway`.
- Routing permission change (D14) hides nothing in UI today but API refuses edc-only actors: UI bead needed before release.
- Duitku refunds are manual (D6) until a refund API exists.
