# 1268 W4 captain: catatan mulai

Worktree `../legend-1268-w4`, cabang `ws/1268-w4`, basis 763f88edc (W1 sudah masuk). Jangan `pnpm install`, jangan `git stash`.
Acuan (folder `legend`): `docs/briefs/1268-pos-wire.md` bagian umum + W4; `bd show legend-9yw78.8` (catatan); pola intent/kunci dari W1 (`ws04-pos-order/{intent-store,order-flow,order-wire}.ts`) dan pelajaran `docs/qa/1268-w1-review.md`, pakai ulang, jangan tulis ulang.

- Buka meja: replay bisa mengembalikan sesi `closed` dengan 200; klien wajib cek status. Hold reservasi: tampilkan peringatan sebelum walk-in didudukkan.
- Tanpa sesi tidak ada pesanan; ulang kirim = satu pesanan, kunci dan byte sama; hasil tidak jelas punya jalan keluar (kirim ulang / tutup sesudah diperiksa); keranjang captain per outlet+aktor+sesi meja; keranjang dikunci selama kirim.
- Fire memakai id item server; `request_bill` butuh acknowledge.
- Jangan ubah `ws04-pos-kasir` (W2 sedang jalan) dan server. Butuh server: lapor.
- Test gagal-dulu, pra-gate AGENTS.md, tes `tests/ws04-pos-*` dan `apps/web/test/pos-*`. Commit + push `HEAD:refs/heads/ws/1268-w4` per langkah (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Laporan maks 10 baris.
