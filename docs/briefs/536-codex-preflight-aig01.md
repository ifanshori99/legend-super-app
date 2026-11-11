# 536 Dua kartu kecil backend (Codex engineer)
Peran: engineer (~/.agents/team/roles/engineer.md). Dua kartu terpisah, berkas tidak bertumpuk: kerjakan paralel dengan subagent Codex. Jangan sentuh berkas refund/payment (sedang digabung di int/batch48i).
Worktree: `git worktree add .worktrees/<nama> -b ws/<nama> origin/milestone/m1` per kartu. Commit lokal, push ke cabang kerja boleh, jangan merge.

1. legend-gi697 (cabang ws/preflight-0301): migrasi 0301 (unique partial index customer+plan, sudah di m1 atau cabang ws/fac07-outbox-events; cek) gagal bila production punya langganan duplikat. Tulis query preflight read-only (SQL, mis. `scripts/preflight/0301-duplicate-subscriptions.sql`) yang mendaftar duplikat customer+plan sesuai predikat index, plus langkah resolusi di docs/deployment.md bagian gerbang rilis. Bukti: test DB (vitest terarah) yang menyisipkan duplikat sebelum index ada lalu query menemukannya, dan nol baris saat bersih.
2. legend-0hyxn (cabang ws/aig01-business-date): test ai-gateway [AIG-01] kuota harian gagal antara 00:00 dan batas hari bisnis Jakarta karena test mengisi tanggal kalender sedangkan service memakai `businessDateOf`. Perbaiki test (jangan ubah aturan produk) agar memakai `businessDateOf` / jam palsu; tambah kasus jam 01:18 WIB. Bukti: test lulus dengan jam palsu 01:18 dan 12:00.
Test terarah: `LEGEND_TEST_FILES=... heavy pnpm test`; tsc api lewat heavy (satu per giliran). Jangan pnpm check penuh. Postgres test bisa OOM: bila perlu `STARTER_TEST_PG_MEM=1536m`.
Laporan: commit per cabang, bukti test, yang belum.
