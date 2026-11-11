# 538-G5b Fix temuan architect edge hardening (ws/edge-hardening)
Worktree sama (.worktrees/edge-hardening). Test gagal-dulu, commit per temuan, jangan merge.
- P1 `apps/api/src/edge/runtime.ts:1093-1103`, `audit-retention.ts:118`: edge production tanpa MAINTENANCE_DATABASE_URL crash saat boot (outlet kehilangan POS offline). Keputusan CTO: (1) baca URL sebelum komponen apa pun start; (2) URL tidak ada -> log error + alarm owner, lewati purge, edge tetap jalan; URL ada tapi salah -> tetap tolak start; (3) dokumentasikan login maintenance + URL di `deploy/edge/README.md` dan `.env.example` (nama key saja), tambah cek di `deploy/edge/check-edge-host.sh`.
- P3 `apps/api/src/edge/cloud-http.ts:300,357`: cache `cloudRejectsRefusals` selamanya -> coba lagi setelah 1 jam.
- P3 purge memakai jam edge sendiri: jangan dikerjakan di cabang ini; CTO buat kartu setelah ws/edge-catalog-fresh merge.
Bukti: test terarah, typecheck api, eslint/prettier. Lapor dengan angka subagent.
