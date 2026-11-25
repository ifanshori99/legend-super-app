# F1 inti perintah edge ke cloud: catatan mulai

Worktree `../legend-1269-f1`, cabang `ws/1269-f1`, basis 7705b4bed (E1+E2 sudah masuk). Jangan `pnpm install`.
Rancangan: `docs/briefs/1269-f-tiket-poin-dp-standby.md` (ada di folder `legend`): bagian umum, kartu F1, dan aturan di bawah kartu.

- Migrasi bernama `0530_*` (satu saja; idx 526 dan prevId 0525 sementara; CTO merantai ulang saat gabung). Wajib expand-only, cloud dideploy sebelum edge.
- Kunci perintah tetap, dikirim ulang byte sama; hasil tidak jelas tetap `unknown`, tidak pernah kunci baru diam-diam. Outlet dan perangkat diambil dari token terverifikasi, bukan body.
- F1 hanya inti plus satu jenis uji; jangan pasang `payment.*`, `points.*`, `promo.*`, `deposit.*`. Jangan ubah `edge/mode.ts` dan `pos-order-payment.ts`.
- Test gagal-dulu: putar ulang sama byte, body beda kunci sama = tolak, dua kirim bersamaan satu eksekusi, crash di tengah, outlet salah = 403, cloud mati = unknown lalu pulih, kedaluwarsa. Lewat `heavy`.
- Pra-gate AGENTS.md, commit + push `HEAD:refs/heads/ws/1269-f1` tiap langkah (commit diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Tanpa `git stash`.
- Laporan maks 10 baris: commit, test, yang belum diverifikasi, keputusan.
