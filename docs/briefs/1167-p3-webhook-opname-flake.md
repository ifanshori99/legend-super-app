# 1167 P3 guard webhook, opname buta, akses, flake (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `ws/1144-refund-hold-echo` (d217d439d, SIAP batch96; memuat perubahan besar `payment-webhook.service.ts` dari 1135/1139/1144). Cabang kerja: `ws/1167-p3-webhook-opname`. Landing sesudah batch96. Tingkat S, kecuali f03o (akses/uang webhook): reviewer opus + architect high untuk f03o/tipkj.

## Kartu
1. `legend-f03o` DOIT webhook: secret sama di beberapa integrasi bisa salah atribusi pemilik saat retry (`loadWebhookSecrets` dedup menyimpan yang pertama; baris MALFORMED payload null hilang). Fix: anggap pemilik bila secret terverifikasi sama dengan secret integrasi pemilik event; event tidak boleh hilang.
2. `legend-tipkj` webhook: claim/geser `updated_at` di jalur kirim ulang DOIT dan sweep event recurring (`payment-webhook.service.ts` ~1796-2041 di m1; cari ulang di base). Berurutan SESUDAH f03o (file sama), satu implementer.
3. `legend-0hzu` opname buta: penghitung bisa menebak stok lewat percobaan waste/transfer (409 berulang) (`inventory-ops.shared.ts:~359`). Fix: jawaban tidak membocorkan jumlah stok selama opname buta berjalan.
4. `legend-qi21` izin `hr.announcement.manage`: kode sudah di m1, sisa test akses route (`apps/api/src/test/hris-announcement*.test.ts`).
5. `legend-inflf` flake `payroll-payout-990-recon-attest`: 1149 menambah diagnostik; cari akar masalah (architect subagent), perbaiki test atau kode. Bila tidak tereproduksi dalam 3 run terarah, catat bukti di kartu dan lanjut.

## Batas
- Jangan sentuh: `order-given.ts`, `payment-admin*`, `accounting-journal*`, `reservation-*`, `payroll-payout-gl.service.ts`, `platform-approval.service.ts`.
- Tanpa migrasi. Bila ternyata perlu: berhenti dan lapor ke CTO untuk nomor.

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), typecheck api lewat `heavy` sekali, prettier + eslint file berubah, `db:generate` kosong. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan review dan fixnya, yang belum teruji.
