# Hasil second opinion 166 — guard master edge dan limiter bootstrap

Bersih: tidak ada temuan P1/P2 baru.

- Run gabungan: brief 218, mengikuti prosedur 217; 9 November 2026.
- Rentang: `a8c90378..d2beba65`.
- Milestone diperiksa: `milestone/m1` pada `94d769c6da4ca5a00972fea5d0d18f1b727a6d6b`.
- Limiter, master sync dan service snapshot tidak berubah lagi setelah tip brief; perubahan app berikutnya tidak memindahkan limiter.
- Pemeriksa: satu subagent Codex khusus 166; parent memeriksa kembali mount, limiter, guard dan pembungkus error snapshot. Empat subagent pada run gabungan, puncak empat bersamaan.

| Id brief | Kartu | Hasil | Kartu baru yang dibuat | Catatan singkat |
| --- | --- | --- | --- | --- |
| 166 | legend-uznb, legend-8izz | Bersih | Tidak ada | Mount sebelum tenant, dua guard, dan sanitasi galat snapshot tetap ada. |

## Jawaban pertanyaan brief

- Urutan middleware: `apps/api/src/app.ts:236` memasang edge route guard; limiter bootstrap di `:309`; resolusi tenant baru di `:315`. Limiter membaca IP/header/bearer dan counter lokal tanpa DB (`apps/api/src/routes/edge-bootstrap.routes.ts:117`). Pada penolakan ia melempar 429 sebelum `next()`. Mount hanya prefix bootstrap; `WeakSet<Request>` menghindari penghitungan dua kali pada router, tanpa marker yang dapat dipalsukan klien.
- Bucket: `/masters` memiliki batas 120 per IP dan 30 per IP+kredensial per menit (`edge-bootstrap.routes.ts:66`); key kredensial adalah hash seluruh bearer, sehingga pengetahuan node ID saja tidak menghabiskan bucket node asli. Bucket kedua hanya diambil bila IP belum menolak.
- Kapasitas armada: loop master membatasi interval minimal 60 detik (`apps/api/src/edge/master-sync.ts:368`). Pada steady state satu polling per node per menit, 120 request/IP/proses adalah batas teoretis tanpa burst; boot, retry dan request lain mengurangi ruangnya. Armada aktual dan burst belum diukur. Batas NAT sudah didokumentasikan, bukan temuan baru.
- Store per proses: setiap factory membuat counter lokal, LRU berkapasitas 20.000 per bucket. Dengan N proses yang membagi trafik, batas agregat bisa menjadi N kali. `docs/deployment.md:211` sudah menjelaskan batas lokal ini; limiter bersama/ingress diperlukan bila kebijakan menghendaki batas global ketat.
- Semantik guard: `edge.bootstrap` adalah source deployment (`apps/api/src/config/data-import.ts:63`), sehingga guard mengikuti klasifikasi deployment lokal. Guard ada sebelum fetch (`master-sync.ts:351`) dan sebelum tulisan pertama apply transaksi (`:179`). Penolakan mencegah semua jenis master ditulis. Ini sesuai perilaku impor deployment yang ada. Provenance klasifikasi data cloud belum dibuktikan guard lokal dan sudah berkartu `legend-h0q4`; tidak diduplikasi.
- Galat snapshot Codex 124: `apps/api/src/services/edge-master-sync.service.ts:50` membatasi catch ke `DrizzleQueryError`/`DatabaseError`; log hanya kelas dan SQLSTATE, kemudian 503 tetap tanpa cause (`:54`). Galat non-DB tetap diteruskan (`:120`). Test sentinel/log/body tersedia di `apps/api/src/test/edge-master-sync.test.ts:1549`, tetapi tidak dijalankan ulang pada run ini.

## Deduplikasi dan batas verifikasi

- `bd search` bootstrap, masters, limiter, DATA_IMPORT, rate limit, snapshot dan h0q4. Tidak ada kandidat baru yang memerlukan kartu.
- Review melalui Git, pembacaan kode dan test yang relevan. Parent memastikan mount/guard/sanitasi yang dilaporkan masih ada di milestone.
- Tidak menjalankan suite, build, uji HTTP mounted-app, atau load test. “Bersih” tidak menyatakan kapasitas armada produksi sudah terukur atau test gate lulus pada run ini.
- Hanya berkas hasil ini yang ditulis untuk brief 166; tidak ada kode, checkout, commit, merge, push atau penutupan kartu.
