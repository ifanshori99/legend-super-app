# Brief: second-opinion (Codex, effort xhigh) — 302 gateway registry + Duitku

## Peran
Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Baca-saja: jangan mengubah kode, jangan commit, jangan push.

## Yang direview
Cabang `ws/gateway-adapter-duitku` (worktree `.worktrees/gateway-adapter-duitku`), diff terhadap `milestone/m1` 7d388b02. Kartu `legend-l9rji`, `legend-pa21`. Tingkat K: uang, kredensial, webhook.

Bacaan wajib:
- `docs/briefs/302-payment-gateway-adapter-duitku.md` (tujuan, keputusan founder Q72-Q74, tiga asumsi aman).
- `docs/briefs/sub-302-design.md` (D1-D27; salinan di `docs/DECISIONS.md` bagian "302 gateway registry").
- Dokumentasi resmi Duitku: https://docs.duitku.com/api/en/ (rumus signature HMAC-SHA256: inquiry, transactionStatus, getpaymentmethod, callback).

## Pertanyaan yang harus dijawab (dengan file:line)
1. Uang tidak pernah lunas dua kali: callback ganda, callback + poller, callback sesudah `failed`/`expired`, ganti gateway saat intent berjalan (PAY-05).
2. Callback Duitku: signature tidak mencakup `resultCode`. Pastikan lunas hanya lewat `transactionStatus` dengan kredensial pencetak intent; nominal dicek; `merchantOrderId` milik tenant di URL.
3. Rumus signature persis sama dengan dokumentasi resmi untuk keempat panggilan; perbandingan constant-time.
4. Kredensial: tidak pernah keluar di respons, log, error, audit; secret lama hanya diterima selama tenggang; rotasi teraudit.
5. Isolasi tenant dan outlet: aturan routing, kredensial, test koneksi, webhook lintas tenant.
6. Registry: tidak ada jalur produksi yang memanggil `setPaymentGateway` (shim test); gateway yang dimatikan Super Admin tidak memutus intent berjalan, poller, webhook, refund.
7. Cadangan otomatis: dipakai hanya saat utama `down` atau dimatikan; failover kasir hanya saat keduanya tidak bisa.
8. Migrasi 0211: aman untuk data yang ada, seed benar, generate kedua kosong; tidak ada RLS yang hilang.
9. Refund Duitku: tetap jalur manual yang ada, tidak ada jalur baru.

## Hasil
Tulis ke `docs/briefs/302b-second-opinion-gateway-adapter.result.md`: temuan per tingkat (blocker, penting, kecil) dengan file:line dan skenario gagal konkret, lalu daftar yang sudah dicek dan aman. Bahasa biasa.
