# Second opinion Codex: edge (15 Nov 2026)

Rentang: origin/milestone/m1 ke fix/edge-so-816 (797cd58d6), fix/edge-snapshot-tolerant (92accc51e), ws/edge-reliability (af66b0d36), ghostex/fc38212e (45d1f1b41). Thread G8dy8, read-only. Hasil: 1 P1. Tidak ada temuan di snapshot-tolerant, sequence dead letter, atau lintas tenant.

1. P1 apps/api/src/edge/db-link-store.ts:391 dan :405 (45d1f1b41): proof rentang > 20.000 slot atau receipt berlubang mengembalikan null; hello tanpa proof, tetapi apps/api/src/edge/link-peer.ts:409 tetap ackOutbound(cursor). Restore instance sama dengan selisih besar: event baru termasuk alarm panik di-ack tanpa terkirim. Fail-open ini keputusan eksplisit 848 (docs/briefs/848-design.md Revisi 1 R2), tetapi risiko kehilangan tetap ada.

Catatan: kompatibilitas edge lama bergantung urutan upgrade di docs/deployment.md:434 (runbook), bukan temuan baru.

Keputusan CTO (brief 854): peer modern (mengirim header x-edge-restore-proof) tidak pernah di-ack tanpa proof. Proof bertahap maks 20.000 slot per putaran; edge hanya meng-ack prefiks yang terbukti. Slot tanpa receipt tidak di-ack; edge mengirim ulang, cloud menjawab already_received dan menulis receipt, sehingga lubang tertutup sendiri. Peer lama tetap perilaku lama.
