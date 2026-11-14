# 854 Edge: restore proof fail-closed untuk peer modern (engineer Sonnet, tingkat K)

Temuan: docs/qa/second-opinion-edge-15nov.md (P1). Keputusan CTO ada di berkas itu.

- Cabang fix/edge-proof-854 dari ghostex/fc38212e (45d1f1b41).
- Peer modern (header x-edge-restore-proof): tidak ada ackOutbound tanpa proof. Proof bertahap: cloud membuktikan (A, min(A+20000, N)]; edge hanya meng-ack prefiks terbukti; putaran berikut melanjutkan.
- Slot tanpa receipt: tidak di-ack; edge kirim ulang; cloud already_received menulis receipt (sudah ada sejak 848); lubang tertutup. Pastikan tidak ada loop reconnect cepat (backoff tetap).
- Peer lama (tanpa header): perilaku lama persis.
- Test gagal-dulu: restore instance sama dengan selisih > 20.000 tidak meng-ack alarm panik yang belum terkirim; receipt berlubang sembuh lewat kirim ulang; peer lama tetap tersambung.
- Paralel: test-writer, implementer cloud (db-link-store), implementer edge (link-peer).
- Jangan sentuh master-sync.ts, edge/edc. Tanpa migrasi.
- Review: satu subagent architect effort high.
- Pra-gate AGENTS.md. Commit + push tanpa force. Lapor sha dan angka subagent.

## Desain 854 (engineer; menimpa brief bila bentrok) — konteks bersama implementer/test-writer

Temuan Explore: link-peer.ts onBatch `toSeq <= last` hanya sendAck, tanpa applyInbound; potongan overlap di-slice. Jadi receipt lubang TIDAK pernah tertutup oleh kirim ulang dan event baru di slot <= cursor cloud akan di-ack tanpa diterapkan. Maka cloud juga harus memeriksa batch ulang (replay) untuk peer modern. Tanpa migrasi. Dilarang: master-sync.ts, edge/edc, test e2e/baseline.

### Kontrak (tetap)
1. protocol.ts: `restoreProofSchema` tambah `to: linkCursorSchema.optional()` (hilang = to=cursor hello, perilaku 848). Cloud menghilangkan `to` bila to == inboundCursor (supaya edge 848 tetap jalan di kasus umum); hanya proof parsial/kosong yang memuat `to`.
2. LinkStore.inboundProof(from, to): `Promise<{to:number; count:number; sha256:string} | null>`. Cloud membuktikan prefiks lengkap terpanjang di (from, min(to, from+RESTORE_PROOF_MAX_SLOTS)]: prefiks = slot berurutan from+1..from+k, tiap slot tepat satu receipt yang dihitung (aturan R3 tetap: edge_to_cloud hanya receipt yang event-nya ada di edge_received_events). k=0 -> {to:from,count:0,sha256: restoreProofOf([]).sha256}. null hanya bila to < from. Query 1 hanya ambil link_seq (murah) untuk menemukan k; query 2 agregat SQL (count+sha256) atas (from, from+k].
3. link-peer sendHello (cloud, restoreProofAcked !== undefined, cursor N > A): selalu kirim `inboundProof {from:A, to?, count, sha256}` bila store.inboundProof ada (tidak lagi fail-open). N <= A: tanpa proof (tidak ada ack).
4. link-peer onHello (edge): bila cursor > acked dan hello membawa proof dan store.outboundProof: to = proof.to ?? cursor; refuse (LinkProtocolError dengan LINK_RESTORE_PROOF_REFUSAL) bila from > acked, to < from, atau to > cursor; hitung outboundProof(from, to); beda -> refuse (seperti sekarang). Cocok: ackTo = to; `ackOutbound(ackTo)` + onAcked hanya bila ackTo > acked. Tanpa proof (cloud lama): ackTo = cursor (perilaku lama persis). `sentUpTo = ackedUpTo = ackTo` (bukan cursor) supaya (ackTo, cursor] dikirim ulang. cursor <= acked: perilaku lama.
5. link-peer onBatch (cloud): bila `options.restoreProofAcked !== undefined` (peer modern) dan store.reconcileReplay ada, bagian batch yang slotnya <= last (events.slice(0, min(last,toSeq)-fromSeq), linkSeq = fromSeq+1+i) diperiksa lewat `store.reconcileReplay({events})` SEBELUM ack/apply sisanya; sisa (> last) diterapkan seperti biasa. Peer lama: perilaku lama persis. reconcileReplay melempar LinkProtocolError (alasan diawali LINK_RESTORE_PROOF_REFUSAL) bila mismatch -> tidak ada ack.
6. LinkStore tambah `reconcileReplay?(input:{events: readonly {linkSeq:number; event: EventEnvelope}[]}): Promise<void>` (cloud, db-link-store.ts). Per slot (satu transaksi, dalam penomoran edge + peerNumbering offset): receipt ada dengan event_id sama -> ok; receipt tidak ada dan event ada di edge_received_events (edge_to_cloud) -> sisipkan receipt 'superseded' ON CONFLICT DO NOTHING (cara sama dengan already_received di applyInbound) -> ok; selain itu (receipt event lain, atau event tak dikenal) -> throw LinkProtocolError(`${LINK_RESTORE_PROOF_REFUSAL} replayed slot N holds a different event; refusing to resume`). Hanya untuk inbound edge_to_cloud; arah lain: no-op.
7. link-client: penolakan proof dari sisi cloud (close reason diawali LINK_RESTORE_PROOF_REFUSAL) juga tidak mereset backoff (cek `proofRefused` ~:183/:269; sekarang hanya penolakan lokal). Tidak ada loop reconnect cepat.
8. docs/deployment.md (~:434 urutan upgrade): catat bahwa hello cloud 854 memuat `to` pada proof parsial; upgrade edge dulu, baru cloud; edge 848 menolak hello proof parsial (fail-closed).

### Potongan (file tidak bertumpuk)
- implementer EDGE: protocol.ts, link-peer.ts, link-client.ts, docs/deployment.md (butir 1,3,4,5,7,8).
- implementer CLOUD: db-link-store.ts (butir 2,6).
- test-writer: apps/api/src/test/edge-link-restore-854*.test.ts (vitest, tulis baru; jangan ubah test lama kecuali bentrok kontrak: laporkan).

### Test gagal-dulu (wajib)
a. Fake-store/link-peer: edge restore instance sama, cloud N - A > 20.000 (proof parsial to=A+20.000): ack hanya sampai to; alarm panik pending di slot > to TIDAK di-ack (status pending); sentUpTo kembali ke to dan dikirim ulang.
b. Proof kosong (to=from, lubang di A+1): tak ada ack; edge kirim ulang dari A; peer tersambung.
c. DB: receipt berlubang di slot s: inboundProof mengembalikan prefiks (to=s-1); replay batch berisi event terdaftar di slot s menulis receipt superseded dan di-ack; putaran berikut inboundProof > s lengkap.
d. DB/cloud: replay batch dengan event baru (tak terdaftar) di slot <= cursor -> LinkProtocolError, tidak di-ack, tidak ada receipt ditulis.
e. Peer lama (tanpa header): onBatch dup ack lama persis; hello tanpa proof; edge ack cursor (perilaku lama). Hello tanpa `to`: to=cursor.
f. Close dari cloud dengan reason refusal tidak mereset backoff (link-client).
g. Hello strict: field tak dikenal tetap ditolak; `to` ditolak bila negatif.
Helper test yang sudah ada: edge-link-restore-proof.test.ts (refProof, withFrom, event, helloFrame, lone, settle, connect), edge-link-restore-proof-db.test.ts (proofOfEvents, outboundProof), edge-link-restore-capability.test.ts.

## Revisi 1 (review architect; CTO-lite: pilih b, saran architect)
Edge 848 juga kirim header x-edge-restore-proof tapi tidak paham `to` dan tidak menahan backoff pada tolakan cloud -> loop cepat. Maka "peer modern" = edge 854 saja:
R1. protocol.ts: `LINK_RESTORE_PROOF_V2_HEADER = "x-edge-restore-proof-v2"` (nilai "1"). link-client (edge) kirim keduanya bila store.outboundProof ada. link-server (cloud) parse: v2 ada -> `restoreProofStrict: true` ke createLinkPeer (opsi baru `LinkPeerOptions.restoreProofStrict?: boolean`; hanya valid bila restoreProofAcked ada).
R2. Cloud tanpa strict (edge 848): perilaku 848 persis: sendHello hanya mengirim proof bila prefiks terbukti == seluruh rentang (to == cursor), selain itu hello tanpa proof (fail-open 848, diterima untuk edge lama); TIDAK ada reconcileReplay; tanpa `to` di kabel.
R3. Strict (edge 854): butir 3,5 desain 854 (proof parsial/kosong, `to`, reconcileReplay) hanya di sini. Gate reconcileReplay = restoreProofStrict.
R4. deployment.md: betulkan :289 dan :368 ("cloud first, then edge") menjadi konsisten: urutan bebas; edge 848 tetap jalan seperti 848 (fail-open proof tak lengkap); proteksi fail-closed aktif per edge setelah edge itu 854. Hapus klaim backoff yang salah di :371.
R5. Opsional link-peer onHello: `sentUpTo = ackedUpTo = Math.max(ackTo, Math.min(acked, cursor))`? JANGAN (resend dari bawah acked dibutuhkan untuk heal receipt); biarkan sesuai desain.
