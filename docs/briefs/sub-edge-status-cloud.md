# Brief: status edge ke cloud S1-S5 (legend-uux9k, 0cjzz, eo3lc, m8vf0, n5u8w)

Desain WAJIB diikuti: `docs/design/edge-status-cloud.md` (D1-D8, section 3 DTO, section 4 slice dan file yang boleh disentuh, section 6 test T1-T28).
Cabang kerja: `ghostex/9ace49c3` (dasar `origin/milestone/m1`). Migrasi kerja nomor 0678 (0679 cadangan): generate di m1, ganti nama berkas ke `0678_edge_node_alerts.sql`, perbaiki `meta/_journal.json` dan snapshot hanya bila perlu; FK tabel baru inline di `CREATE TABLE`.

## Keputusan CTO (di luar desain)

- `tenant_admin` TIDAK diberi `report.operational.view`.
- "Edge offline" (legend-5ab0l) JANGAN dikerjakan.
- Jangan merge `wip/1041-hard-stale`. Tidak ada perubahan frame protokol atau header heartbeat.

## Aturan kerja subagent

- Hanya file di tabel slice (section 4) dan file test baru. Butuh keluar scope: berhenti dan lapor ke engineer.
- Jangan menjalankan `tsc`, `vitest`, e2e, atau build kecuali diberi tugas itu (satu token heavy per thread). Test terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree.
- Satu panggilan Bash = satu perintah sederhana. Tanpa heredoc, `$(...)`, array zsh.
- Tipe brand (`TenantId`, `OutletId`, ...): pakai konstruktor/helper bertipe proyek, bukan `as`.
- Izin, label, event baru wajib terdaftar di katalog root dan label teks. Tabel baru masuk tes cakupan tabel schema dan `apps/api/src/test/data-import-registry.test.ts`.
- Uang tidak tersentuh slice ini. Jangan log cookie, token, kredensial. Detail alert: hanya hitungan dan waktu.
- Cloud selalu ambil tenant, outlet, node dari kredensial edge atau sesi terverifikasi, bukan dari body.
- Test pola acuan: `apps/api/src/test/edge-print-*.test.ts`, `edge-device-registry-*.test.ts`, `edge-device-sync-stale.test.ts`. Path test relatif ke `apps/api`: `src/test/...`.
- Test gagal-dulu harus gagal karena sebab yang benar (modul/perilaku belum ada), bukan karena setup, 422, atau ID salah.

## Pembagian test (section 6)

- A: T1-T4 (`src/test/edge-node-alert-service.test.ts`) dan T14-T21 (`src/test/edge-node-status-api.test.ts`).
- B: T5-T13 (`src/test/edge-node-alarm-*.test.ts`).
- C: T22-T25 (`src/test/edge-device-sync-receipt-alert.test.ts`).
- D: T26-T28 (web, di `apps/web` sesuai pola test fitur web yang ada; ui-auditor dipanggil engineer).
