# 848 Explore (read-only) — konteks
Tugas besar: edge restore DB proof (docs briefs ada di git: `git show ux/customer-order-benchmark:docs/briefs/848-edge-restore-proof.md`; prototipe tahan: `git show ux/customer-order-benchmark:docs/qa/held/edge-tmar2-held.patch`).
Masalah: edge DB direstore dari backup; cursor cloud (received_in_seq edge_to_cloud) lebih tinggi dari antrean edge; hello cloud lalu dianggap ack -> event baru edge (mis. alarm panik) di slot link lama di-ack tanpa terkirim.
Desain yang diusulkan: cloud hello membawa digest SHA-256 atas event id edge_to_cloud di rentang (A, N] + jumlah; A = acked_out_seq edge (dikirim edge, mis. lewat header fitur upgrade); edge hitung ulang dari antrean sebelum ackOutbound; beda -> LinkProtocolError, tanpa ack.
Jawab ringkas dengan path:line. Jangan edit.
