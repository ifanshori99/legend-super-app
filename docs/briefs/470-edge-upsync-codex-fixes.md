# Brief: perbaikan temuan Codex — up-sync transaksi edge + rekonsiliasi (legend-kai)

Peran: engineer (`~/.agents/team/roles/engineer.md`). Cabang `ws/kai-edge-upsync` (e52264d4); buat worktree `.worktrees/kai` lagi. Keputusan CTO: semua nyata. Termasuk legend-4vwaj (dedupe ledger setelah antrean dipangkas). Migrasi: ubah 0286 sementara (belum di-merge), atau 0291 bila perlu terpisah.

1. P1 `drizzle/0286_edge_txn_ledger.sql:56`: backfill baca `sync_cursors` (FORCE RLS) tanpa konteks tenant -> migrasi gagal di DB lama dengan owner tanpa BYPASSRLS. Keputusan: backfill per tenant dalam blok DO yang `set_config('app.tenant_id', ...)` per tenant (ikuti pola migrasi backfill lain di repo bila ada). Test dengan role non-superuser + data lama.
2. P1 `edge-reconciliation.service.ts:200`: digest tidak terikat instance/epoch; `peer_seq_offset` instance sekarang dipakai untuk digest instance lama -> mismatch palsu / ok palsu. Keputusan: digest membawa instance id/epoch; tolak digest yang epoch-nya bukan epoch aktif (status `stale`), simpan epoch di run.
3. P2 :110: count + total tidak membuktikan identitas event (hilang 1 + ganda 1 = ok). Keputusan: tambah digest identitas tak bergantung urutan (mis. jumlah/XOR hash event_id mod 2^64, simpan di ledger) dan bandingkan di cloud.
4. P2 `edge-txn-ledger.service.ts:82`: kontrak digest terima 30 digit, ledger bigint. Keputusan: batasi kontrak ke rentang bigint (tolak > 9223372036854775807) dan tolak di enqueue dengan error jelas, bukan rollback diam. Test batas.
5. P2 :223: run tidak menyimpan `fromLinkSeq`. Simpan + tampilkan from, through, epoch.
6. legend-4vwaj: ledger unik per event_id (re-enqueue setelah pangkas tidak terhitung dua kali). Test.

Paralel: test-writer gagal-dulu per butir, implementer per file (migrasi, reconciliation.service, ledger.service), lalu architect xhigh. Bukti: test gagal-dulu, 3 berkas kai + regresi link hijau, eslint+prettier, typecheck api heap 6144, commit+push. Laporan: commit, angka test, angka subagent.
