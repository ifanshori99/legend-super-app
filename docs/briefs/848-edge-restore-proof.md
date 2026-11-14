# 848 Edge: deteksi restore DB tanpa kehilangan event (engineer Sonnet, tingkat K)

Kartu: legend-tmar2 (restore DB edge tanpa trafik cloud_to_edge: event hasil restore di bawah received_in_seq cloud di-ack tanpa dikirim), legend-g1799 (rotasi edge_nodes.instance_id saat DB edge hasil restore/klon terdeteksi).

Bahan: prototipe Codex yang DITAHAN di docs/qa/held/edge-tmar2-held.patch (bukti merah: proof hanya ID terakhir masih meng-ack alarm panik yang belum terkirim). Jangan terapkan apa adanya.

Keputusan CTO:
- Proof mencakup SELURUH rentang yang akan di-ack, bukan ID terakhir. Contoh bentuk: cloud hello membawa digest bergulir (mis. SHA-256 atas event id edge_to_cloud dalam (ack lama, received_in_seq]) plus jumlahnya; edge menghitung ulang dari antrean sebelum ackOutbound. Beda atau baris hilang: LinkProtocolError, tidak ada ack.
- Kompatibel: hello strictObject; edge kirim header fitur, cloud menambah field hanya bila header ada. Edge lama tetap jalan seperti sekarang.
- g1799: rotasi instance_id hanya bersama prosedur recovery yang jelas (re-register node + reset cursor lewat jalur yang sudah ada), sehingga cursor lama tidak membuat edge buntu. Bila butuh desain besar, selesaikan tmar2 dulu dan lapor usulan g1799.

- Langkah 0: `git log --all --oneline --grep=<id>`; bila sudah dikerjakan, berhenti dan lapor.
- Test wajib: restore instance sama tanpa trafik cloud_to_edge ditolak tanpa ack; alarm panik yang belum terkirim tidak pernah di-ack; edge lama tanpa header tetap tersambung.
- Paralel: Explore 2 (link protocol cloud, antrean edge), test-writer gagal-dulu, implementer per kartu.
- Jangan sentuh master-sync.ts, edge/edc, cash-out.
- Migrasi: tidak diharapkan; bila perlu 0389.
- Review: satu subagent architect effort high.
- Pra-gate AGENTS.md. Commit + push tanpa force. Lapor dengan angka subagent.
