# Second opinion akses ronde 3 — perbaikan 1024 + 1026 + 1027

Tanggal: 18 November 2026. Brief 1030. Hasil: **1 P1 dan 1 P2 tersisa**, tanpa P0/P3 tambahan yang terbukti. Skenario asli ronde 2 sudah ditutup pada kode target; kedua temuan di bawah menyangkut pencatatan pertama sesi dan penggunaan snapshot sebelum pencatatan itu. P1 masih menghalangi gerbang rilis area akses.

## Cakupan dan ref

```sh
git diff origin/ghostex/4b06e171...origin/ghostex/1027-guard-http-perangkat-bersama -- . ':!**/meta/*snapshot.json'
```

Baseline: `0069c8c59889670d527ed5bc61343136d2c5948f`. Target: **`a35b9cc9aa6c0a2422ccc7eb071971a627ca2655`**, rantai 1024 `e3cb158f2` → 1026 `432f2e6c2` → 1027 `a35b9cc9a`. Diff mencakup 20 berkas, 1.728 penambahan dan 151 penghapusan. Seluruh nomor baris merujuk isi target tersebut, bukan checkout utama.

Pemeriksaan membaca kedua laporan sebelumnya dan pengecualian CTO di brief 1023/1030. Tiga subagent read-only berjalan paralel, puncak tiga bersamaan; hasil digabung dan kandidat temuan diuji kembali dengan sumber asli di memori. Tidak checkout, membuat worktree, menjalankan layanan, mengubah kode, commit, atau push. Hanya laporan ini yang ditulis. Kedua celah residual juga berasal dari alur yang sudah ada pada baseline; laporan ini tidak menganggapnya regresi baru yang diperkenalkan seluruhnya oleh 1024–1027.

## Temuan

- **P1 — Guard `/api/auth` mengenali perangkat bersama tetapi tidak menyimpan tanda, sehingga retry tanpa header kembali menjadi owner:** `apps/api/src/middleware/shared-device-auth.ts:69`, `:76`, `:91`; pengaktifan mode di `apps/api/src/services/device.service.ts:640` hanya menjadwalkan penutupan sesi pada transisi mematikan mode. **Skenario:** Owner sudah login dengan password ketika perangkat POS masih `shared_mode=false`, sehingga sesi mempunyai `sharedDeviceIds=[]`. Admin dari perangkat pribadi kemudian mengaktifkan shared mode pada POS tersebut. Tablet mengirim cookie dan token perangkat valid ke `/api/auth/get-session`; allowlist langsung meneruskan tanpa pencatatan. Bahkan bila tablet lebih dahulu mencoba `/api/auth/update-user`, guard memang menolak 403 karena perangkat aktif/shared, tetapi tetap tidak menyimpan tanda. Cookie yang sama kemudian dikirim tanpa kedua header perangkat/kasir ke `POST /api/auth/update-user`, atau ke route back office/POS: sesi masih `[]`, sehingga guard tidak mengenali tablet dan memakai identitas owner tanpa PIN. Ini tidak memerlukan login ulang, password baru, atau token kasir. **Perbaikan:** Saat jalur autentikasi menerima cookie sesi dan token perangkat bersama valid, simpan tanda sebelum meneruskan maupun menolak request; pastikan pembacaan sesi yang diizinkan juga melakukan pencatatan tersebut. Pengaktifan mode harus tetap aman untuk sesi yang diterbitkan sebelum perangkat ditandai shared. **Usul test:** Buat sesi password ketika perangkat belum shared, aktifkan mode dari sesi pribadi terpisah, lalu kirim GET `get-session` berheader perangkat dan periksa tanda tersimpan. Replay cookie tanpa header ke `update-user` dan back office wajib 403, POS wajib `401 ACTING_STAFF_REQUIRED`, tanpa perubahan profil/data/audit tindakan owner. Ulangi setelah request `/api/auth/update-user` berheader yang awalnya ditolak 403, serta ke tenant/outlet kedua yang dapat diakses owner.
- **P2 — Request pertama masih dapat memakai snapshot tanda kosong setelah tanda permanen berhasil ditulis:** `apps/api/src/middleware/auth.ts:75`, `:83`; dampak POS di `apps/api/src/middleware/acting-staff.ts:141` dan penghapusan push di `apps/api/src/services/notification-push-ports.ts:66`. **Skenario:** Sesi lama belum bertanda, lalu perangkat diaktifkan sebagai shared. Request pertama tanpa PIN memuat snapshot `[]`; `stampSharedDeviceFromToken` berhasil menulis `[D]`, tetapi `req.auth.session.sharedDeviceIds` tetap `[]`. Di antara pencatatan dan pemeriksaan berikutnya, admin pribadi mematikan shared mode D; penutupan sesi gagal atau belum selesai. Pemeriksaan berikutnya membaca snapshot kosong dan status perangkat yang kini tidak shared, sehingga request back office/POS tersebut lolos sebagai owner. Pada `removePush`, `resolveCaller` menghasilkan `sharedDevice=false`, sehingga SQL memilih cabang penghapusan seluruh langganan milik owner, termasuk ponsel lain. Request berikutnya sudah membaca `[D]` dan ditolak; celah ini terbatas pada request yang sudah berjalan ketika transisi terjadi. **Perbaikan:** Propagasikan hasil pencatatan ke konteks request, atau simpan klasifikasi shared yang tidak dapat turun kembali selama request; pakai hasil yang sama pada guard back office, POS, dan resolver push. **Usul test:** Gunakan barrier setelah pencatatan `[D]`, matikan shared mode dari sesi admin terpisah dengan penutupan sesi sengaja gagal, lalu lanjutkan request pertama. Back office wajib 403, POS wajib 401 tanpa kasir, dan DELETE langganan ponsel owner wajib ditolak dengan baris tetap ada. Pastikan request setelahnya juga tetap tertutup dan kontrol sesi pribadi tidak berubah.

## Penutupan temuan ronde 2

| Temuan sebelumnya | Bukti pada target | Penilaian |
| --- | --- | --- |
| P1 perangkat dicabut reconnect KDS sebagai owner | `kds-realtime-auth.ts:170`–`:193` memakai setiap tanda historis; setiap token perangkat yang dikirim wajib diterima registry; setiap token kasir yang dikirim di-resolve dengan sesi, perangkat, dan outlet tujuan. `device.service.ts:576` dan `:646` menutup sesi terkait dan meminta pemeriksaan ulang socket setelah commit. | Skenario asli tertutup. Header lama, cookie saja dengan tanda historis, dan outlet lain ditolak; token kasir kedaluwarsa/dicabut tidak beralih menjadi owner. |
| P2 perangkat kesembilan via WebSocket | `kds-realtime-auth.ts:162`–`:168` memanggil `closeSessionAtMarkLimit` sebelum menolak. `shared-device.service.ts:126`–`:148` menyediakan revoke beraudit dan fallback delete. | Skenario asli tertutup. Bila close gagal, delapan tanda yang tetap tersimpan masih menutup replay tanpa header. |
| P2 tablet menghapus push ponsel owner | `notification.routes.ts:144` mengisi caller untuk `removePush`; `notification-push-ports.ts:66` mempertahankan klasifikasi shared untuk snapshot yang sudah bertanda; `notification-center.ts:558`–`:566` membatasi DELETE menurut user dan sesi/perangkat pemanggil. | Skenario asli dengan sesi sudah bertanda tertutup. Race pencatatan pertama tetap menjadi P2 tersendiri di atas. |
| Penutupan sesi gagal setelah revoke/unflag | `auth.ts:33`, `shared-device-auth.ts:77`, `acting-staff.ts:150`, dan `kds-realtime-auth.ts:170` memeriksa tanda historis tanpa mensyaratkan perangkat masih aktif/shared. | Snapshot yang sudah memuat tanda tetap tertutup. Hilangnya baris perangkat juga tidak membuka owner. Snapshot kosong dalam request pertama belum sepenuhnya tertutup. |

## Pemeriksaan lain

- Batas delapan: `shared-device.service.ts:93`–`:109` memilih tanda yang tidak aktif dan langsung menambahkan penggantinya; daftar tidak menjadi kosong. Pada status perangkat yang stabil, tanda aktif tidak dipilih untuk eviction. Tidak ditemukan skenario tambahan yang terbukti membuka akses owner melalui eviction.
- Perangkat pribadi: Tidak ada perubahan kode produksi pada 1026; perubahan menyelaraskan premis test kelola perangkat dengan guard back office. Sesi tanpa tanda dan tanpa token tetap dapat menjadi owner KDS. Kontrol ini juga dijalankan dalam harness resolver di bawah.
- Keep-alive dan sign-out: Tetap ada di allowlist. Test `shared-device-lapse-fail-closed-1027.test.ts:210` memeriksa kenaikan kedaluwarsa sebenarnya, `:237` memeriksa penghapusan sesi setelah sign-out, dan `:267` memeriksa sesi pribadi. Test tersebut dibaca, belum dijalankan dalam review ini.
- SSR/server function, upload, dan ekspor yang ditelusuri tetap menuju guard API; tidak ditemukan bypass tambahan yang terbukti untuk sesi yang sudah mempunyai tanda. Kebocoran tenant/outlet tambahan juga tidak terbukti di jalur KDS dan push yang diperiksa. Kedua temuan di atas tetap dapat mewarisi jangkauan tenant/outlet owner apabila request lolos sebagai owner.
- Test tambahan pada target mencakup real socket revoke/reconnect dengan header dan subprotocol ke outlet A/B (`kds-realtime-shared-device.test.ts:1478`), perangkat kesembilan (`:1632`), revoke SQL tanpa menutup sesi (`:1852`), recheck segera (`:1919`), serta push lintas perangkat/tenant dan perangkat pribadi (`push-removal-shared-device-1024.test.ts:283`, `:307`, `:379`). Kehadiran test tidak dihitung sebagai bukti kelulusan.

## Bukti executable

Dua pemanggilan `heavy node --input-type=module` selesai dengan exit 0. Keduanya membaca fungsi asli melalui `git show a35b9cc9a:<path>`, membuang tipe dengan `node:module.stripTypeScriptTypes`, lalu menjalankannya di memori. Import diganti dependency stub untuk auth, registry, status perangkat, penulisan tanda, dan permission; tidak ada berkas harness, server, atau database yang dibuat. Assert memeriksa keluaran aktual berikut, termasuk kondisi yang mereproduksi temuan.

| Kasus | Hasil kode asli dengan dependency stub |
| --- | --- |
| `/api/auth`, sesi belum bertanda, perangkat aktif/shared | GET `get-session` berheader diteruskan; POST `update-user` berheader ditolak `403 ACTING_STAFF_NOT_ALLOWED`; POST yang sama tanpa header diteruskan; tanda tetap `[]`. |
| Race request pertama: pencatatan berhasil lalu perangkat unflag sebelum guard berikutnya | Tanda tersimpan `[D]`, snapshot request `[]`; guard back office dan rangkaian auth/POS sama-sama memanggil `next()` tanpa kasir. |
| Resolver push memakai snapshot kosong pada race yang sama | `sharedDevice=false`; kontrol snapshot `[D]` menghasilkan `true`. Pemilihan cabang DELETE selanjutnya diperiksa dari SQL sumber, tidak dieksekusi ke database. |
| Request sesudah race | Back office dan `/api/auth/update-user` ditolak 403; POS tanpa kasir ditolak 401. |
| KDS aktif dengan token kasir valid | Identitas `cook`. |
| KDS perangkat dicabut, sesi bertanda masih hidup | Token lama, cookie tanpa token, dan target outlet B seluruhnya menghasilkan `null`/ditolak. |
| KDS perangkat kesembilan | Ditolak dan fungsi close dipanggil sekali; stub close tidak menghapus sesi, tetapi replay tanpa header masih ditolak oleh tanda historis. |
| KDS pribadi dan token kasir berakhir pada perangkat unflagged | Sesi pribadi tanpa token menghasilkan `owner`; token kasir berakhir menghasilkan `null`, tanpa fallback owner. |

Pencatatan tanda dan perpindahan status pada harness disimulasikan sebagai urutan dependency stub yang sesuai dengan kode sumber; ini membuktikan cabang middleware/resolver, bukan reproduksi konkurensi database atau eksploitasi HTTP end to end. Keberadaan sesi awal tanpa tanda saat perangkat diaktifkan shared dibuktikan dari alur `setDeviceSharedMode` pada sumber.

`git diff --check` atas rentang review selesai tanpa temuan whitespace. Request HTTP nyata, real websocket dengan database, PostgreSQL/RLS, test integrasi proyek, build, dan gate penuh tidak dijalankan. Checkout utama berbeda dari target dan tidak dipindahkan.

`pnpm exec prettier --check docs/qa/second-opinion-akses-ronde3.md` dicoba, tetapi gagal sebelum pemeriksaan karena `node_modules/prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`). Tidak memasang dependensi atau mengubah berkas lain untuk memperbaiki lingkungan review.

## Rekomendasi gerbang

Tahan gerbang rilis area akses sampai P1 diperbaiki dan regresi transisi perangkat pribadi → bersama dibuktikan melalui HTTP nyata. Sertakan perbaikan P2 beserta test barrier pada request pertama agar pencatatan tanda tidak dapat dibatalkan oleh snapshot lama. Validasi kembali real-socket dan push milik 1024 serta kontrol keep-alive/sign-out setelah perbaikan.
