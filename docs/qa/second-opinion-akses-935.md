# Second opinion akses 935

- Tanggal: 17 November 2026.
- Brief: `docs/briefs/944-second-opinion-akses-935.md` di repo utama.
- Rentang: `c17c60df7ca80f4dc4af8de06faae4e43d40ac80..8a661cd906451ce2769bd07f61cff1c3446ea55f` (`origin/ghostex/935-foto-penerimaan-stale-edge`).
- Cabang hasil: `qa/second-opinion-akses-935`, berbasis `origin/milestone/m1` pada `c17c60df7`.
- Metode: Tiga subagent read-only, puncak tiga bersamaan; pemeriksaan gabungan terhadap kode target melalui `git show` dan `git diff`. Nomor baris di bawah merujuk tip target, bukan HEAD cabang QA.
- Ringkasan: Dua P1; tidak ada P0, P2, atau P3. Alert cloud yang diterima CTO (`legend-uvnll`) dikecualikan.

## Temuan

1. `apps/api/src/services/device.service.ts:857` — **P1** — Pemeriksaan hard-stale hanya melindungi enroll, penerbitan token perangkat, dan heartbeat; jalur pembuatan sesi POS tetap menerima perangkat yang tidak memiliki sesi berjalan. **Skenario:** Replika terakhir berhasil ditarik 96 jam lalu; perangkat masih active di replika tetapi `lastSeenAt` null atau lebih tua dari lima menit, dan token perangkat belum kedaluwarsa (TTL 90 hari). Dengan cookie login anggota outlet dan PIN yang sah, kirim `POST /api/staff-pins/pos-session` tanpa heartbeat. Rantai `registeredDeviceIdOf` → `deviceTenantCredential` → `findActiveDeviceForToken` tidak memeriksa hard-stale maupun sesi berjalan; `issueActingStaff` tetap menerbitkan token kasir baru, sedangkan heartbeat perangkat yang sama ditolak 503. Bila cloud sudah mencabut perangkat selama edge offline, pencabutan itu juga belum diketahui replika. **Perbaikan:** Terapkan aturan penerimaan sesi perangkat di jalur autentikasi/perolehan sesi yang dipakai seluruh endpoint perangkat, dengan pengecualian yang jelas bagi sesi yang memang sudah berjalan; jangan memblokir semua permintaan perangkat aktif. **Usul test:** Atur hard-stale true, token valid, `lastSeenAt` null/10 menit lalu, cookie dan PIN sah; `POST /api/staff-pins/pos-session` harus menolak tanpa menulis token acting-staff. Pasangkan kasus replika fresh dan sesi perangkat aktif yang tetap dapat melanjutkan transaksi.

   Bukti pendukung: `apps/api/src/routes/pos-acting-staff.routes.ts:33-65`, `apps/api/src/routes/device-id.ts:50-55`, `apps/api/src/services/platform-tenant.service.ts:36-67`, `apps/api/src/services/device-registry-check.ts:38-67`, `apps/api/src/services/pos-acting-staff.service.ts:101-188`, `apps/api/src/lib/device-token.ts:24`.

2. `apps/api/src/edge/runtime.ts:387` — **P1** — Status registry yang belum siap dianggap tidak hard-stale saat startup, sehingga perangkat lama dapat memperoleh pengecualian sesi aktif sebelum checkpoint basi dimuat. **Skenario:** Restart edge dengan checkpoint terakhir sukses 96 jam lalu dan perangkat ber-token valid yang sudah lama tidak heartbeat. HTTP server sudah menerima permintaan; runtime memasang identity outlet sebelum memasang registry puller. Pada jeda itu `registryPuller` masih null dan `isDeviceRegistryHardStale()` mengembalikan false. Bahkan setelah puller dipasang, `lastSuccessAt` masih null sampai `load()` selesai, sehingga predicate memakai waktu startup. Heartbeat pertama diterima dan mengisi `lastSeenAt`. Setelah checkpoint lama dimuat, hard-stale menjadi true, tetapi heartbeat berikutnya setiap 30 detik terus lolos pengecualian lima menit. **Perbaikan:** Pisahkan status registry belum siap dari fresh; tahan penerimaan sesi perangkat baru sampai checkpoint lokal berhasil dimuat dan dinilai, tanpa perlu menunggu koneksi cloud. Jangan memperbarui bukti sesi aktif dari permintaan yang diterima selama status belum diketahui. **Usul test:** Tahan promise pemuatan checkpoint atau tahap startup sesudah identity tersedia; kirim heartbeat perangkat tidak aktif dan pastikan ditolak/tetap menunggu, tanpa perubahan `lastSeenAt`. Lepaskan checkpoint berumur 96 jam, gagalkan cloud pull, lalu pastikan heartbeat tetap 503. Tambahkan pasangan checkpoint fresh dan sesi yang sebelumnya memang aktif.

   Bukti pendukung: `apps/api/src/server.ts:85,169-172` (listen mendahului boot; tidak ada readiness middleware), `apps/api/src/edge/runtime.ts:925-941,1174-1176`, `apps/api/src/edge/device-registry-puller.ts:149-153,205-210`, `apps/api/src/routes/edge-device.routes.ts:214-219`, `apps/api/src/services/device.service.ts:850-857,874-883`.

## Area tanpa temuan konkret

- Foto penerimaan: Filter SQL tenant/outlet/purpose/umur, penautan atomik hanya oleh pengunggah, penolakan foto lintas tenant/outlet serta foto yang sudah tertaut, dan pembacaan berdasarkan izin outlet. Input klien tidak dapat menetapkan owner, tenant, createdAt, atau source ID.
- URL foto: Purpose bersifat private; respons upload tidak mengeluarkan URL publik; signing memeriksa tenant, outlet dan izin objek. Masa berlaku ditetapkan server 300 detik dan tidak dapat diperpanjang lewat parameter klien.
- Konfigurasi: Default hard-stale 259.200 detik (72 jam), integer 3.600–2.592.000 detik dan minimal dua kali soft-stale; runtime meneruskan nilai ke puller.
- Panel edge: Teks notice baru memakai `deviceRegistry.staleNotice.*` dan terdaftar di katalog. Tidak ditemukan teks panel baru di luar katalog.

## Verifikasi dan batas

- Review statis dilakukan pada SHA target yang dipatok di atas, termasuk test foto akses/purpose, storage resolver, hard-stale service/puller dan panel. Pembacaan test tidak dianggap sebagai hasil run test.
- `git diff --check c17c60df7..8a661cd90`: Lulus (exit 0).
- Reproduksi terisolasi lewat `heavy node --disable-warning=ExperimentalWarning --input-type=module`: Kode `device-registry-puller.ts` langsung dari SHA target dimuat dengan `stripTypeScriptTypes`; promise `load()` ditahan, lalu dilepas dengan checkpoint berumur 96 jam dan cloud pull gagal. Dua assertion lulus (exit 0): `isHardStale()` false sebelum checkpoint tersedia, true sesudahnya. Ini bukti predicate aktual, bukan reproduksi HTTP/startup lengkap.
- Test API/HTTP, database, browser, build dan koneksi object storage tidak dijalankan dalam review ini. Skenario HTTP pada temuan didukung penelusuran rantai guard/service, belum direproduksi sebagai integration test.
- Pemeriksaan Prettier tidak dapat dijalankan: `pnpm exec prettier --check docs/qa/second-opinion-akses-935.md` melaporkan command tidak ditemukan; executable repo utama juga gagal karena modul `prettier/bin/prettier.cjs` tidak tersedia. Dependensi tidak dipasang untuk review read-only ini.
- Kode produk tidak diubah; hanya berkas hasil QA ini ditambahkan. Beads dan status kartu dikelola CTO sesuai aturan peran Codex.
