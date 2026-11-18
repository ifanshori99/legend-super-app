# Brief: merge train lanjutan batch91-93 (tenggat founder: kode beres akhir 19 Nov)

Peran: merge train (baca `~/.agents/team/roles/merge-train.md`). Lanjutkan langsung sesudah batch90 landing, tanpa menunggu CTO di antara batch.

## Urutan
Daftar dan SHA: `docs/merge-queue.md` (folder utama, baris SIAP). Rencana batch dari CTO 18 Nov:
- batch91: `ghostex/34755844` a4fd0a639 -> `ghostex/1018-kds-ws-subprotocol-keep-alive` f854663f9 -> `ghostex/4b06e171` 0069c8c59 -> `ghostex/6acce68c` e3cb158f2; `ghostex/1026-kelola-perangkat-acting-staff` 432f2e6c2; `ghostex/1027-guard-http-perangkat-bersama` 195fcc31e -> `ghostex/pin-kasir-tablet-bersama` a20420a6f; `ghostex/8b2dc0b1` e589b3476 (konflik app.ts, middleware/auth.ts); `ws/1092-ci-hemat` d23427421.
- batch92: `ghostex/847b580a` af6845a55 -> `ghostex/so996-f2-f3-charge-void-split` e821ed64f; `ghostex/993-fasilitas-lanjutan` bae5b2c43; `ghostex/ui-finance-recon-clearance` 6c270b04f (generate ulang routeTree.gen.ts); `ghostex/helper-tipe-id-bermerek-drizzle` 2797b55f4; `ghostex/backfill-policy-supplier-tingkat-dasar` f55277c5c; `ghostex/1020-so-recon-ronde-2-fix` c15dd03aa; `ghostex/duitku-fe-ws05` 1e133c584 (cek dulu isinya dan apakah sudah direview; bila ragu, lewati dan lapor).
- batch93: `ghostex/45769078` b8927ea90 (cek SO POS 1064 tanpa P1 di docs/qa; bila belum, lewati); `ws/1073-edge-sweep-race` 053c8dc67; `ws/1073-edge-digest-cancel` 9cade8157; `ws/1081-provisioning-rls` 418510aeb (jalankan provision-roles-audit sendiri); `ws/1082-ui-ponsel` 15bfa3a80; `ws/1086-hris-kecil` 3b0baeb2e -> `ws/1087-akses-lanjutan` 2e178b257; `ws/1085-pos-edc-kecil` 79aa39610.
Selalu ambil SHA terbaru dari merge-queue.md saat mulai batch. Migrasi dirender ulang berurutan dari tip m1 (nomor kerja di cabang hanya label).

## Mempercepat
- Siapkan batch berikut (merge ke int/batchNN baru, typecheck, test terarah) selama full run batch sebelumnya berjalan, dalam batas `heavy` (maks 2 jalur berat; tsc satu per Mac).
- Satu full run per batch. Kegagalan yang jelas milik satu cabang: keluarkan cabang itu, lanjutkan batch, lapor; jangan tahan seluruh batch.
- Sesudah e2e/visual: matikan dev server dan browser milik batch.

## Laporan
Satu laporan per batch landing (SHA m1, cabang masuk/keluar, migrasi, waktu). Jangan akhiri giliran untuk "Menunggu" (founder Q10).
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
