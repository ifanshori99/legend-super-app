# 1191 Refund hold hardening (engineer Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore area, test-writer fail-first, satu implementer per kartu dengan berkas terpisah, architect di akhir).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Base: `int/batch97` (431cb2c04; berisi 1144/1167/1176/1182 yang menyentuh refund-hold, akan mendarat di m1). Cabang: `ws/1191-refund-hold-hardening`. Tingkat K (uang: refund): architect effort xhigh. Migrasi: hindari; bila perlu pakai 0730-0731 saja.

## Kartu (`bd show <id>`)
1. `legend-tbygu`: hold palsu dari echo refund milik kita yang sudah selesai (event id baru, tanpa refund id). Kecualikan transaksi yang sudah tertutup penuh oleh refund kita, atau kunci per laporan. Jangan meloloskan echo yang jumlahnya melebihi refund tercatat.
2. `legend-rdg29`: poller 1045 berhenti menanyakan hold `own_refund_failed_unverified` setelah 12 galat atau jawaban paid. Tambah retry berkala (backoff) + alert ulang; hold tetap tertahan sampai terbukti.
3. `legend-r7oi3`: test race kredit DP vs hold konflik atomik (r1-04) di `refund-1075-r1-hold-atomic-race.test.ts`, fixture lintas tenant. Bila test menemukan bug, betulkan.
4. `legend-sy98y`: `paymentReference` + `outletName` di `refundReconHoldViewSchema` (packages/shared), service, dan baris panel refund holds. Cek `origin/ghostex/1033-kredit-dp-pool-net-bersama` a3d2340e2 yang mungkin sudah punya outletName; jangan duplikasi. Teks UI baru masuk katalog (`node --test tests/text-contract.test.mjs`).

## Jangan sampai rugi
Bukti test: tidak ada refund ganda, tidak ada hold yang lepas tanpa bukti, total refund <= diterima, isolasi tenant. Bila ragu, tahan (hold tetap).

## Batas
Jangan sentuh reservation-*, payroll-payout*, payment-webhook* di luar kebutuhan kartu, edge/*, sealed/reseal.

## Bukti selesai
Fail-first per kartu (merah di base, hijau sesudah). Test refund-* terkait hijau (terarah lewat heavy). Typecheck api; web juga karena shared+web berubah (sekali, lewat heavy). Prettier + eslint. Architect xhigh, temuan dibetulkan. Commit, push, tutup kartu. Tunggu job heavy dengan Bash run_in_background satu notifikasi; jangan Monitor/loop foreground; tanpa laporan antara.

## Laporan
SHA, kartu ditutup, subagent total dan puncak, gate, yang belum teruji. Lapor sekali.
