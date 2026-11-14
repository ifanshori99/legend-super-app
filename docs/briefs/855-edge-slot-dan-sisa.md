# 855 Edge: tabel slot per link dan sisa bug edge (engineer Opus)

Cabang fix/edge-slot-855 dari fix/edge-proof-854 (50818b5f6). Langkah 0: `git log --all --oneline --grep=<id>` per kartu; sudah dikerjakan di cabang lain: lapor, jangan ulang.

Kartu (bd show <id> untuk detail):
- legend-pz641: tabel slot per link (tenant,node,direction,link_seq,event_id) + index untuk restore proof; tutup slot bolong, ganti scan penuh, naikkan batas proof 20000 (keputusan 854: proof berpotongan prefix, slot tak terbukti dikirim ulang). Migrasi: rentang 0440-0444.
- legend-fgd9b: receipt dead-letter memakai link_seq mentah tanpa peer_seq_offset (link-dead-letter-applier.ts:74).
- legend-rs2xy: event approval/akuntansi tenant-wide ditolak producer di edge.
- legend-2uqcd: resep modifier lintas brand tidak ada di edge, potong stok dilewati.
- legend-cgduz: edge menolak start bila modifiers_recipe_fk ada di DB edge.

Aturan: test gagal-dulu per kartu. Kompatibilitas peer lama (tanpa header v2) tidak berubah. Backfill slot dari receipt yang ada di migrasi, idempoten.
Paralel: Explore edge-link, test-writer, satu implementer per kartu (file terpisah; pz641 dulu bila menyentuh file yang sama dengan fgd9b).
Review: satu subagent architect effort xhigh (migrasi) atas seluruh diff.
Pra-gate AGENTS.md. Commit + push tanpa force. Klaim kartu dengan bd, jangan close (CTO). Lapor sha, test, temuan review, angka subagent.
