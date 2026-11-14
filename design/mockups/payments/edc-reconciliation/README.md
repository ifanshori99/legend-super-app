# Rekonsiliasi transaksi EDC

Mockup back office untuk Owner dan Finance Manager meninjau transaksi EDC yang ditandai, memeriksa bukti, lalu menetapkan hasil rekonsiliasi. Acuan pekerjaan: `legend-khi8n`, endpoint pada cabang `fix/edc-followups`.

## Berkas dan cakupan layar

- `edc-reconciliation.html`: mockup HTML responsif untuk desktop dan lebar 390 px, dalam Bahasa Indonesia.
- Daftar transaksi: outlet, kasir, nominal, waktu transaksi, status `unknown` / `approved` / `declined`, dan umur transaksi.
- Detail transaksi: konteks transaksi, struk, dan trace terminal sebagai dasar keputusan.
- Penyelesaian: pilihan hasil approved atau declined, konfirmasi keputusan, lalu MFA.
- Kondisi penting: masih menunggu respons terminal, kosong, gagal memuat atau menyimpan, dan penyelesaian berhasil.

Seluruh nama, nominal, nomor struk, trace, dan waktu merupakan **contoh data** untuk peninjauan desain. PNG desktop/mobile beserta kondisi waiting, confirmation, empty, dan error disimpan di folder ini setelah render; hasil pemeriksaan dilaporkan dalam handover.

## Pola visual yang diikuti

Mengikuti arah back office yang sudah ada, tanpa membuat arah visual baru: `DESIGN.md` v3, `design/screens/ui-bo-config/5ac3-normal-1280.png`, serta pola HTML `design/mockups/backoffice/supplier-invoice-0xnm.html` dan `jurnal-outlet-5ac3.html`.

Kepadatan **Padat & Presisi** memakai Plus Jakarta Sans yang ditanamkan ke HTML, canvas abu hangat, kartu putih, garis batas lembut, angka tabular, dan aksen petrol untuk aksi utama. Status selalu memiliki teks; warna membantu membaca, bukan menjadi satu-satunya pembeda.

## Tiga keputusan desain

1. **Tabel menjadi kartu pada mobile.** Desktop mendukung perbandingan antartransaksi dengan kolom yang sejajar. Pada 390 px, tiap transaksi menjadi kartu berlabel agar nominal, outlet, kasir, status, dan umur tetap terbaca tanpa gulir horizontal.
2. **Bukti diperiksa sebelum resolusi.** Detail menempatkan struk dan trace bersama identitas serta nominal transaksi sebelum tindakan penyelesaian. Pengguna memastikan hasil terminal yang sebenarnya sebelum memilih hasil; status `unknown` bukan bukti bahwa pembayaran ditolak.
3. **Menunggu terminal membatasi tindakan; keputusan memerlukan MFA.** Ketika terminal masih menunggu respons, kontrol penyelesaian dinonaktifkan dan alasan ditampilkan. Transaksi yang boleh direkonsiliasi melewati konfirmasi hasil dan MFA sebelum simulasi keberhasilan.

## Acuan kontrak dan batas mockup

- Endpoint penuh: `POST /api/payments/admin/edc/transactions/:id/reconciliation` pada `fix/edc-followups`. Acuan: `packages/shared/src/edc/index.ts:464`, `apps/api/src/services/edc-reconciliation.service.ts:137`, dan `apps/api/src/routes/payment-admin.routes.ts:198`.
- Body: `outcome` (`approved` / `declined`), `evidence.source` (`inquiry` / `terminal_receipt` / `bank_statement`), `evidence.note` wajib 1–500 karakter, `chargedAmountIdr` wajib pada approved, `approvalCode` opsional alfanumerik 1–12, `rrn` opsional alfanumerik 1–24. Nominal bukti approved harus sama dengan permintaan dan sisa tagihan.
- Pending/in-flight menolak kedua keputusan. Approved hanya dapat diselesaikan approved; declined hanya declined. Unknown dapat keduanya setelah bukti diperiksa. Tidak ada alur void di mockup ini.
- Izin `payment.reconcile` pada outlet dan MFA sesi wajib. Rekonsiliasi tidak langsung membukukan pembayaran; tender ECR normal tetap menjadi jalur pencatatan pembayaran tepat sekali.
- Mockup menggambarkan pilihan hasil `approved` / `declined`; nilai dan label harus mengikuti kontrak implementasi yang berlaku.
- Mockup ini tidak memanggil API, mengautentikasi MFA, mengunggah bukti, mengubah status pembayaran, atau mencatat uang. Interaksi dan respons merupakan simulasi lokal untuk review layar.
- Pengujian akses Owner/Finance Manager, validasi server, pemeriksaan status terminal terbaru, penolakan respons yang kedaluwarsa, pencatatan audit, serta jaminan tidak terjadi pembayaran berlebih harus dibuktikan pada implementasi API/UI berikutnya.


## Cara meninjau

Buka `edc-reconciliation.html` langsung di browser. Pemilih **Kondisi layar** mengubah kondisi contoh. Pada mobile, pilih **Periksa transaksi** untuk masuk detail dan **Kembali ke daftar** untuk kembali. Konfirmasi memerlukan centang pemeriksaan dan kode MFA simulasi `123456`; kode tersebut bukan rahasia atau kredensial.

PNG utama: `edc-reconciliation-desktop.png` (1440 px) dan `edc-reconciliation-mobile.png` (390 px). PNG kondisi memakai awalan `detail`, `waiting`, `confirmation`, `empty`, `error`, `save-error`, dan `success`, dengan akhiran `-desktop.png` / `-mobile.png`.

`verify.mjs` memeriksa kondisi layar pada 1440, 390, dan 320 px serta guard simulasi. Jalankan melalui `heavy --browser node design/mockups/payments/edc-reconciliation/verify.mjs`; memakai Playwright yang sudah ada dan Google Chrome lokal. Bila link paket di checkout rusak, arahkan `PLAYWRIGHT_MODULE` ke paket `playwright-core` yang sudah terpasang; jangan mengubah dependensi aplikasi untuk merender mockup. Hasil dicatat di `verification.json`.

## Catatan bukti desain

Pola tabel/kartu dan shell berasal dari dua mockup BO serta satu screenshot implementasi (bukti visual kuat untuk konsistensi lokal). Pilihan detail di bawah tabel dibandingkan dengan drawer: dipilih agar bukti dan formulir dapat diperiksa berdampingan di desktop; biaya pilihan ini adalah halaman lebih panjang. Pada mobile, detail menggantikan daftar untuk mengurangi kepadatan. Tidak ada aset atau riset pengguna eksternal yang diklaim.

Tidak mengubah kode aplikasi, tidak menjalankan `bd`, dan tidak menjalankan build/test monorepo karena hasil pekerjaan hanya mockup. Review founder dan bukti transaksi nyata tetap di alur coordinator.

## Verifikasi terbatas mockup

- Pemeriksaan Ghostex desktop 1440 px dan mobile 390 px: tidak ada luapan atau perbaikan layout otomatis.
- Review kontrak dan review visual dilakukan dua subagent; temuan metadata, hasil sukses, dan ikon diperbaiki.
- Kontras pasangan utama dihitung: ink/putih 17,21:1; muted/putih 6,74:1; CTA 7,44:1; unknown 6,12:1; approved dan declined masing-masing 6,48:1. Ini tidak menggantikan audit aksesibilitas menyeluruh.
- Context7 menolak permintaan karena kuota bulanan habis. Rujukan fallback: [Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype) dan [Screenshots](https://playwright.dev/docs/screenshots), sesuai paket lokal 1.63.0.

## Gerbang hasil (cakupan mockup)

| Area | Hasil | Bukti / batas |
| --- | --- | --- |
| Product | PASS | Brief dan kontrak `fix/edc-followups`; data contoh ditandai |
| UX | PASS | Bukti → hasil → konfirmasi → MFA; pending terkunci |
| UI | PASS | BO Padat & Presisi; hierarki dan ikon direview |
| Design system | PASS | Dua mockup BO dan satu screenshot implementasi |
| Accessibility | NOT VERIFIED | Label, fokus dan kontras diperiksa; audit axe lengkap belum dijalankan |
| Responsive | PASS | 1440 / 390 / 320 px, 11 kondisi per lebar tanpa luapan |
| Edge cases | PASS | Kosong, loading, gagal, pending, berhasil, nominal berbeda, MFA salah |
| Code quality | PASS | JavaScript mockup berjalan tanpa browser error; bukan pengujian kode aplikasi |
| Visual QA | PASS | Ghostex visual check + PNG Chrome; review desktop/mobile oleh subagent |
| Anti-slop | PASS | Gaya BO existing, tidak ada grafik dekoratif atau klaim produk buatan |
| Final | NOT VERIFIED | Audit aksesibilitas menyeluruh dan uji dengan pengguna di luar cakupan bukti ini |

Hasil otomatis terakhir: **36 pemeriksaan lulus, 0 error browser** (`verification.json`). Termasuk 33 kombinasi lebar/kondisi serta pemeriksaan nominal, MFA, outcome, penguncian ulang, dan kegagalan penyimpanan. Dua subagent dipakai untuk eksplorasi, review kontrak, dan audit visual.
