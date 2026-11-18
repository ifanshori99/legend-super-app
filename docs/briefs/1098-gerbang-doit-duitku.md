# Brief: engineer — DOIT/Duitku: kontrak sandbox + query gerbang rilis 1

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu (base `milestone/m1`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Tanpa migrasi (0710-0711 cadangan, hanya dengan izin CTO).

## Kartu
Di awal: `ghostex board associate legend-bcb4p` + `bd update legend-bcb4p --status in_progress`. Kartu lain hanya `bd comment`.
1. `legend-bcb4p` (kode). Cocokkan `GET /v1/recurring/subscriptions/{id}` dan `?reference=` dengan sandbox DOIT. Kunci ada di `~/.config/legend/doit-sandbox-api-key` (prefix `pb_test_`). Tambah probe opsional mengikuti pola `apps/api/src/test/payment-doit-sandbox.test.ts`: skipIf bukan `pb_test_`, kunci tidak pernah tercetak. Probe membuat 1 langganan sandbox, GET by id dan by reference, lalu cancel. Bandingkan dengan parser `payment-doit-recurring-wire.ts` / `payment-doit-recurring.ts`. Bila beda: betulkan adapter dan unit test (`payment-doit-recurring-get.test.ts`, `-wire.test.ts`). Simpan bukti tersunting di `docs/qa/evidence/doit-sandbox/bcb4p-*.redacted.json`.
2. `legend-etov3` query gerbang (before `0445_recurring_unresolved_start_key`, predikat kedua RAISE di 0445, mode block).
3. `legend-47rgt` query gerbang (before `0446_promotion_ai_action_request_key`). Cari promo dengan marker `[ai:<uuid>]` sama per tenant yang jumlahnya >1 dan masih aktif. Mode block. Resolve: nonaktifkan promo kedua dst. (keputusan CTO).
4. `legend-7tqe8` + `legend-1yig6` (siapkan saja): probe Duitku sandbox skipIf tanpa `DUITKU_SANDBOX_MERCHANT_CODE`/`DUITKU_SANDBOX_API_KEY`. Isinya host `paymentUrl` e-wallet/kartu vs allowlist, field kartu VC, status QRIS sesudah expiry, `expiryPeriod` minimum, dan status untuk `merchantOrderId` tak dikenal. Tidak dijalankan sekarang (kunci datang 20 Nov). Tulis satu perintah jalan di `docs/qa/duitku-sandbox-gerbang.md`.

## Aturan
- Konvensi query: sama dengan brief 1097 (`scripts/preflight/rilis1-legend-<id>.sql`, header `gate/before/requires/mode/resolve`, satu SELECT murni, nama tabel tanpa skema, keluaran id + jumlah saja). Test di `apps/api/src/test/preflight-rilis1-payment.test.ts` (pola temp-clone `preflight-0301.test.ts`).
- Uang: test wajib membuktikan promo AI ganda yang aktif dan baris langganan belum-selesai ganda memunculkan baris (diskon ganda / tagih dobel). Data bersih nol baris.
- Refund otomatis TETAP MATI (Q45). Jangan sentuh `payment-refund-gateway.ts`, `pos-refund-gateway.ts`, atau berkas yang diubah `ws/1072`. Probe tidak boleh membuat refund.
- Probe tidak pernah berjalan di CI dan tidak pernah memakai kunci live. Test gagal bila kunci muncul di pesan/log.
- Bila sandbox DOIT tidak menyediakan recurring: catat bukti, adapter jangan diubah, laporkan sebagai eksternal.
- `legend-vntqt` bukan bagian brief ini (cabang `ghostex/duitku-fe-ws05` antre train).
- Tabrakan: cek diff `origin/int/batch90` dan `ws/1072*`. Jangan ubah `docs/deployment.md` dan `predeploy-check.ts`.

## Pembagian paralel
- Explore (2): wire/adapter recurring DOIT dan pemanggil resolve/reconcile; predikat 0445/0446 + adapter Duitku (`payment-duitku-wire.ts`).
- test-writer (1): test gagal-dulu query 2-3.
- implementer (2): probe+adapter DOIT; query 2-3 + probe Duitku (berkas terpisah).
- test-runner: pemegang token heavy (probe sandbox DOIT, test terarah, typecheck API sekali).
- architect (effort xhigh, uang): review perubahan adapter DOIT (bila ada) dan predikat query. reviewer sonnet: probe Duitku.

## Bukti selesai
Probe DOIT jalan sekali dengan bukti tersunting, test terarah recurring + preflight lulus, merah-dulu tercatat, typecheck API lulus.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Pra-gate AGENTS.md. Commit di cabang `ws/1098-gerbang-doit-duitku`, push tanpa `--force`.

## Laporan
Hasil per kartu (kontrak DOIT cocok/beda + apa yang diubah), bukti, berkas, commit, cabang, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
