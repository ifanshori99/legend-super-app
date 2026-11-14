# 854 Edge: restore proof fail-closed untuk peer modern (engineer Sonnet, tingkat K)

Temuan: docs/qa/second-opinion-edge-15nov.md (P1). Keputusan CTO ada di berkas itu.

- Cabang fix/edge-proof-854 dari ghostex/fc38212e (45d1f1b41).
- Peer modern (header x-edge-restore-proof): tidak ada ackOutbound tanpa proof. Proof bertahap: cloud membuktikan (A, min(A+20000, N)]; edge hanya meng-ack prefiks terbukti; putaran berikut melanjutkan.
- Slot tanpa receipt: tidak di-ack; edge kirim ulang; cloud already_received menulis receipt (sudah ada sejak 848); lubang tertutup. Pastikan tidak ada loop reconnect cepat (backoff tetap).
- Peer lama (tanpa header): perilaku lama persis.
- Test gagal-dulu: restore instance sama dengan selisih > 20.000 tidak meng-ack alarm panik yang belum terkirim; receipt berlubang sembuh lewat kirim ulang; peer lama tetap tersambung.
- Paralel: test-writer, implementer cloud (db-link-store), implementer edge (link-peer).
- Jangan sentuh master-sync.ts, edge/edc. Tanpa migrasi.
- Review: satu subagent architect effort high.
- Pra-gate AGENTS.md. Commit + push tanpa force. Lapor sha dan angka subagent.
