# 855 Edge: tabel slot per link dan sisa bug edge (engineer Opus)

Cabang fix/edge-slot-855 dari fix/edge-proof-854 (50818b5f6). Brief CTO asli: `git show ux/customer-order-benchmark:docs/briefs/855-edge-slot-dan-sisa.md`. Konteks 854 (restore proof v2, reconcileReplay, inboundProof, peerNumbering offset): `docs/briefs/854-edge-proof-fail-closed.md`.

## Status kartu

- legend-2uqcd, legend-cgduz: SUDAH dikerjakan di 87284cbb7 (cabang ws/tax-menu-keyrotation, fix/edge-so-816, ghostex/800-...). Tidak diulang.
- legend-pz641: tabel slot per link + index untuk restore proof. Migrasi rentang 0440-0444.
- legend-fgd9b: receipt dead-letter memakai link_seq mentah tanpa peer_seq_offset (apps/api/src/edge/link-dead-letter-applier.ts:74).
- legend-rs2xy: event approval/akuntansi tenant-wide ditolak producer di edge (core-outbox.ts ~72-79, guard legend-7h5s).

## Aturan bersama

- Test gagal-dulu per kartu, vitest di `apps/api/src/test/edge-*-855*.test.ts`. Gagal karena sebab yang benar.
- Peer lama (tanpa header v2): perilaku tidak berubah.
- Jangan sentuh: master-sync.ts, edge/edc, e2e/acceptance, e2e/visual.
- Test terarah: `LEGEND_TEST_FILES="src/test/a.test.ts" heavy pnpm test` dari root worktree. Satu token heavy per thread.
- Tipe brand: pakai konstruktor brand proyek, bukan `as`.

## Desain (diisi engineer setelah Explore)

### legend-pz641 (tabel slot)

Temuan: receipts = `edge_inbound_events` (schema/edge-node.ts:297), PK (tenant,node,direction,event_id), TANPA index link_seq -> inboundProof (db-link-store.ts:404) dan reconcileReplay (:600) scan semua receipt node. RESTORE_PROOF_MAX_SLOTS 20_000 (:167).

Desain:

1. Tabel baru `edge_link_slots` (cloud + edge, satu migrasi `0440_edge_link_slots`): tenant_id, outlet_id, edge_node_id, direction, link_seq bigint, event_id uuid, created_at timestamptz default now(). PK (tenant_id, edge_node_id, direction, link_seq). FK inline di CREATE TABLE (ikuti edge_inbound_events). RLS tenant+outlet dan trigger append-only seperti 0352 / edge-node.custom.sql.
2. Satu baris slot = slot yang "dipegang" receipt yang dihitung proof (aturan R3): cloud_to_edge selalu; edge_to_cloud hanya bila event ada di edge_received_events. Receipt dead-letter (event tak terdaftar) TIDAK menulis slot.
3. Helper `claimSlot(tx, storedLinkSeq, eventId)`: INSERT ... ON CONFLICT DO NOTHING lalu baca event_id slot; kembalikan cocok/tidak. Dipanggil di setiap penulisan receipt yang dihitung: applyInbound (applied dan already_received superseded), reconcileReplay (receipt ada sama event -> claim juga, mengisi slot yang tak ter-backfill; receipt baru superseded -> claim). Slot dipegang event lain: applyInbound -> logger warn (tanpa rahasia), receipt tetap; reconcileReplay -> LinkProtocolError refusal (seperti sekarang).
4. inboundProof: baca `edge_link_slots` saja (index PK range). Prefiks k dihitung di SQL (gap pertama: `link_seq - (from+off) <> row_number() OVER (ORDER BY link_seq)`), tanpa menarik semua baris ke Node. Digest dari slot (event_id ORDER BY link_seq). RESTORE_PROOF_MAX_SLOTS naik ke 100_000 (cloud saja yang memotong; edge 854 menerima `to` berapa pun <= cursor). Hasil proof harus sama persis dengan sebelumnya untuk data yang sama (sha256 atas event_id lowercase + "\n").
5. reconcileReplay "held": baca slot, bukan JOIN receipts+registry.
6. Backfill di migrasi, idempoten (ON CONFLICT DO NOTHING): dari edge_inbound_events yang dihitung (aturan 2), hanya slot dengan tepat SATU receipt terhitung; slot dengan >1 receipt terhitung dilewati (proof berhenti di sana seperti sekarang, sembuh lewat replay). Daftarkan INSERT di `MIGRATION_DATA_STATEMENTS` (src/test/data-import-registry.test.ts:64). Nomor migrasi 0440 (rentang CTO 0440-0444): generate, lalu ganti nama file/tag/snapshot ke 0440; `pnpm db:generate` setelahnya harus kosong.
7. Tidak ada perubahan kabel/protokol. Peer lama tetap.

### legend-fgd9b (dead-letter offset)

EdgeApplyMeta.peerSeqOffset (ports.ts), diisi applyInbound; applier menulis receipt di `dead.linkSeq + offset`. Dead-letter receipt tidak menulis slot (pz641 butir 2).

### legend-rs2xy

Keputusan desain (sync tenant-scoped vs lampirkan outlet) -> subagent architect, lalu CTO.
Keputusan (architect, engineer setuju): tetap blokir di sumber; tanpa jalur tenant-scoped, tanpa melampirkan outlet node. Satu-satunya producer tenant-wide yang terjangkau edge tanpa gate: worker `runDueDepreciation` (worker-main.ts ~567, accounting-fixed-assets.service.ts:845) dan `runDueRecurringJournals` (~630, accounting-journal.service.ts:454 + approval). Poin (point-ledger:178) sudah ditolak di route qr-order.

1. Test gagal-dulu `apps/api/src/test/edge-worker-cloud-only-gate-855.test.ts` (pola source-regex dari test/edge-worker-refund-gate.test.ts): kedua job hanya dijalankan di dalam `if (sweepsCloudOwnedData)`.
2. worker-main.ts: bungkus kedua panggilan dengan `if (sweepsCloudOwnedData)`; perluas komentar :182-186 (legend-rs2xy).
3. core-outbox.ts:81-94 guard tetap; komentar menunjuk test langkah 1.

## Perbaikan review architect (xhigh)

- F1: 0440 (dan salinan di edge-node.custom.sql) hapus lift NO FORCE/FORCE untuk `outlets` dan `edge_nodes` (FK dibuat di tabel kosong; pemeriksaan FK melewati RLS). Tiga lift lain tetap (edge_inbound_events, edge_received_events, edge_link_slots). Kedua salinan harus identik.
- F2: test/edge-received-events-migration.test.ts suite plain-owner: tambah cek 0440 menulis slot dari receipt terhitung dan FORCE RLS kembali aktif di edge_link_slots (pg_class.relforcerowsecurity).
- F6: services/edge-sync-conflict.service.ts ~:463 meta apply: isi `peerSeqOffset` dari sync_cursors.peer_seq_offset node itu (arah edge_to_cloud), sama seperti applyInbound.
- F7a: edge/runtime.ts ~:285 dan test/edge-db.test.ts ~:143 (daftar RLS): tambah edge_link_slots di samping edge_inbound_events.
- F7b: setiap daftar cleanup tabel di apps/api/src/test/** yang memuat edge_inbound_events: tambah "edge_link_slots" tepat sebelum edge_inbound_events (kecuali 854-db dan restore-proof-db, sudah).
