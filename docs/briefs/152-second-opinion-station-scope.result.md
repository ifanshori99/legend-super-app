# Hasil Codex 152: second opinion station scope + AI scope (G0lh5, 9 Nov 15:37)

Review read-only `ws/station-scope@edab9370` dan `ws/ai-scope@4538a6e4`. Tidak ada bypass baru pada diff. Test terarah 103 lulus, 8 file. Belum: build, lint, typecheck, gate penuh; positive read beberapa tool MCP (TL-05, TL-06, TL-08 kosong, TL-09 belum terdaftar, TL-12 kosong, TL-20).

## Temuan
- **P2 (konteks tidak berubah), `apps/api/src/middleware/permissions.ts:220`**: grant outlet A + station B menghasilkan context A saja, karena station reach hanya dihitung bila outlet reach kosong. Station B hilang dari list dan route ticket B ditolak. Gabungkan kedua reach di gate station, pertahankan filter station di service.
- **Invariant, `apps/api/src/services/ai-action-executors/access.ts:88`**: `holdsToolAccess` menjamin satu role lengkap per outlet, bukan role yang sama di seluruh payload. GM@A + owner@B menghasilkan true. Tidak ada penggabungan permission lintas role pada target yang sama. Literal invariant: `entries.some(entry => targets.every(...))`.
- **Dokumen, `apps/api/src/services/ai-drafts.service.ts:228`**: `gatewayContext` juga membaca kandidat menu dan akun bisnis (disaring scoped reach sebelum ke model/respons). Tidak ada kebocoran konkret, tetapi klaim "hanya bookkeeping" belum benar.

## Keputusan CTO
- Per-outlet role di `holdsToolAccess` diterima (tidak ada eskalasi: tiap target tercakup penuh oleh role yang sah di outlet itu). Dokumen invariant disesuaikan.
