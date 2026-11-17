# Second opinion rotasi kunci reseal — legend-e1mtr

Tanggal: 17 November 2026. Peran: second-opinion. Review statis tanpa checkout,
worktree, perubahan kode, commit, atau push.

Rentang: `892f58a11...origin/ghostex/1002-reseal-chatgpt-push`, dengan tip diverifikasi
sebagai `9b101091826f65ed98a4ffae27f7fd66e3fd6b10`. Snapshot migrasi dikecualikan sesuai
brief. Acuan: `9b1010918:docs/design/reseal-chatgpt-push.md`, Opsi B, terutama §4.4
dan §7. Pemeriksaan dibagi ke tiga subagent paralel: job/push, CAS/lease ChatGPT,
dan runbook/test; puncak tiga subagent berjalan bersamaan. Temuan digabung dan
bukti lokasi diperiksa kembali oleh agent utama.

## Hasil

Satu temuan P2 pada aturan operasional; tidak ada temuan P0, P1, atau P3.
Tidak ditemukan bug kode baru yang terbukti dalam invariant brief. Pengecualian
yang sudah diterima CTO tidak dilaporkan ulang.

- **P2 — Checklist pensiun di keputusan hanya mensyaratkan tiga kolom baru.**
  Lokasi: `9b1010918:docs/DECISIONS.md:12`; rumusan terkait di
  `9b1010918:docs/deployment.md:416` juga menyebut “setiap kolom di atas”.
  **Skenario:** token ChatGPT, pending, dan push sudah v3, sementara satu token
  `orders.payment_link_token_sealed` pada order selesai masih v2. Registry memang
  membekukan kolom itu (`9b1010918:apps/api/src/worker/sealed-secret-reseal.job.ts:247`),
  sehingga laporan dapat menunjukkan tiga kolom baru `remaining=0`, seluruh
  `failed=0`, `failedTenants=0`, `aborted=false`, tetapi kolom order
  `remaining=1, frozen=1`. Pemeriksaan integrasi/AI dan HRIS juga dapat bersih.
  Checklist keputusan tersebut terpenuhi; operator yang memakainya dapat
  melepas v2 dan kehilangan kemampuan membuka token order. Job tetap menghitung
  frozen dengan benar; masalahnya adalah syarat operasional yang lebih sempit
  daripada desain §4.4. **Perbaikan:** nyatakan bahwa seluruh entri `tables` pada
  laporan lengkap harus `failed=0` dan `remaining=0`, termasuk frozen/busy,
  ditambah `failedTenants=0`, `aborted=false`, serta pemeriksaan `rotate-data-key`
  dan `hris-pii-reseal`. Selaraskan kedua dokumen; jangan membatasi ke ketiga
  kolom baru. **Usul test:** perluas test retirement dengan tiga kolom baru
  bersih dan satu token order frozen versi lama; jalankan registry lengkap dan
  pastikan keputusan pensiun tetap ditolak. Helper test saat ini sudah menilai
  seluruh `tables`, tetapi fixture retirement membatasi registry ke push
  (`9b1010918:apps/api/src/test/sealed-secret-reseal-retire.test.ts:346`), sehingga
  kombinasi ini belum dibuktikan di sana.

## Bukti pemeriksaan kode

- ChatGPT menggunakan advisory lock yang sama dengan claim, row lock, aturan
  lease ditambah margin, dan CAS atas tenant/id/generation/operation_id serta
  kedua ciphertext. Tidak ditemukan jalur reseal menimpa token baru di luar
  risiko sisa yang sudah diterima.
- Push memakai AAD writer dengan tenant dan user; ciphertext serta `key_version`
  diperbarui dalam satu UPDATE CAS. Baris terkunci tetap masuk count tanpa
  `SKIP LOCKED`; frozen tetap masuk `remaining`.
- `reportOnly` melewati mutasi registry, JSON, dan service sweep. Count service
  dilakukan dalam transaksi terpisah dan tetap memakai konteks tenant.
- Log error sweep menyembunyikan detail; log hasil memuat hitungan laporan.
  Tidak ditemukan pencetakan token dalam perubahan yang diperiksa.
- Test T1–T8, P1–P6, dan R1–R6 diperiksa secara statis. Keberadaan test bukan
  bukti bahwa test tersebut lulus.

## Verifikasi dan batas

Pembacaan memakai `git diff`, `git show`, dan pencarian pada ref yang dipatok;
baris temuan diverifikasi pada tip tersebut. Perintah
`pnpm exec prettier --check docs/qa/second-opinion-rotasi-kunci.md` dicoba, tetapi
gagal sebelum memeriksa format: modul lokal
`node_modules/prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`).
Dependensi tidak dipasang selama review read-only.

Test aplikasi, build, typecheck, dan database tidak dijalankan dalam review
read-only ini. Temuan P2 berasal dari perbandingan aturan tertulis dengan
perilaku registry; skenario integrasinya belum dijalankan. Satu-satunya berkas
yang ditambahkan oleh review ini adalah laporan QA ini. Status Beads diserahkan
kepada CTO sesuai aturan peran Codex.
