# 187b hasil architect (legend-zsdd), 9 Nov 2026

Diperiksa di `integ/m1-batch28` 1f83d4aa (memuat m1 94d769c6 + batch25-28). Merge zsdd: 67e39c66 (64638306).

**Bersih.** Tidak ada temuan P1/P2.

Yang dicek:
- Satu counter, satu database: `ensureSequence` (pos-receipt.service.ts:324-363) hanya menomori baris tak terikat atau terikat ke (node, instance) database ini (`boundToThisDatabase` :294). Cloud memensiunkan baris terikat (`cloud_takeover`) sebelum menomori. `allocateReceipt` :544-566 mengecek ulang `retired_at IS NULL` dan, di cloud, `edge_node_id IS NULL` sesudah lock baris, jadi klaim yang bersamaan tidak bocor.
- Rebuild (instance baru), standby yang naik jadi primary, dan cloud yang mengambil alih selalu mendapat prefix baru dari `nextFreePrefix` atas semua prefix outlet, termasuk yang pensiun. Prefix tidak pernah dipakai ulang. Trigger `receipt_sequences_forward_only` mengunci binding (sekali, NULL ke terisi) dan retire (final).
- Edge yang di-upgrade di tempat: `ensureLocalEdgeNode` (edge-node.service.ts:668-674) memberi instance_id sekali. Klaim pertama mengikat baris tak terikat yang lastNumber 0, dan edge mengikat baris lokal yang sama (`kept`). Counter berlanjut tanpa rotasi.
- EDG-02: urutan struk diterapkan sesudah record perangkat, dan errornya ditangkap (`applyPageReceiptSequences`). TEN-01/02: tenant dan outlet hanya dari `verifiedEdgeNodeSchema`.
- Kompatibilitas: cloud lama menolak `edgeInstance` dengan 400. Fetcher mengulang tanpa urutan struk (cloud-http.ts:221-228).

P3 (catatan, tanpa kartu):
- Baris tak terikat yang sudah dinomori edge era-3yqy lalu edge-nya dibangun ulang tidak bisa dibedakan dari baris kosong. Tidak berlaku karena 3yqy dan zsdd rilis bersama di m1, jadi tidak ada edge 3yqy di produksi. Tetap pastikan tidak ada edge 3yqy terpasang sebelum rilis.
