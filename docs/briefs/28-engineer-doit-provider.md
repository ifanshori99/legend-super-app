# Brief: engineer — DOIT PaymentProvider (legend-b9i)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/doit-provider`, cabang `ws/doit-provider` (dari `main`). Jangan pindah cabang.

## Tujuan
Adapter gateway DOIT di belakang antarmuka PaymentProvider: QRIS, Virtual Account, transfer bank kode unik, daftar metode dari endpoint DOIT, webhook dengan verifikasi `PayBridge-Signature`, simpan-dulu-lalu-proses (dedupe `gateway_webhook_events` per event id), status payload sebagai kebenaran (tidak bergantung urutan), polling status sebagai cadangan, kredensial terenkripsi per tenant. Acuan: PRD v1.7 §3 F13, §7 DOIT (Bearer, Idempotency-Key), PAY-02/03/06 (`docs/PRD.md`). Detail: `bd show legend-b9i`. Ini prasyarat legend-3160 (VA + kartu di web pelanggan).

Aturan founder metode bayar: web pelanggan = QRIS, VA, e-wallet, kartu kredit/debit (+ bayar di kasir); POS = semua itu + EDC. Rancang antarmuka provider agar e-wallet dan kartu bisa ditambah tanpa ubah kontrak; implementasikan yang DOIT dukung.

## Kartu
`legend-b9i`. Di awal: `ghostex board associate legend-b9i` dan `bd update legend-b9i --status in_progress`. Saat melapor: `bd update legend-b9i --status review` dan `bd comment legend-b9i "<ringkasan bahasa biasa>"`.

## Catatan
- Area uang: plan singkat dulu. Nominal integer IDR. Webhook palsu/tanda tangan salah ditolak tanpa efek. Idempotency-Key di tiap request ke DOIT.
- Kredensial DOIT sandbox belum ada (legend-saov, tugas founder). Kerjakan dengan server DOIT palsu di test; jangan pernah minta atau baca kredensial asli. Jangan baca `.env*`.
- Cabang `ws/pos-payment-fixes` juga mengubah service payment POS. Hindari menyentuh file itu; bila terpaksa, sebut di laporan. Migration cabang lain 0063–0065, nomor dirapikan saat merge.

## Scope
- Boleh: `apps/api/src/db/schema/payment*.ts`, migration baru, `apps/api/src/services/payment*.ts` / modul provider DOIT baru, `apps/api/src/routes/payment*.routes.ts` (webhook), test `apps/api/src/test/payment*.test.ts`, kontrak `packages/shared`.
- Jangan: `apps/web/`, `design/`, service POS order/shift/receipt.

## Bukti selesai
- Test: tiap metode, webhook valid/invalid/dobel/urutan terbalik, polling fallback, isolasi lintas tenant, kredensial tidak pernah tercetak di log.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/doit-provider`, pesan merujuk `legend-b9i`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, risiko tersisa, kebutuhan dari CTO/founder.
