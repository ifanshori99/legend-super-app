# Review K B1 kontrak jembatan EDC (ws/1272-b1 f5ef62402)

Reviewer: architect (Opus, xhigh), 27 Nov. Baca kode saja. Hasil: **GAGAL**, 0 P1, 5 P2, 1 P3. Re-review diff perbaikan saja.

## Aman
- Tidak ada "failed" palsu: `refused`/`transport_error` -> `EcrTransportError` -> `unknownPatch()` (`edge/edc/agent.ts`).
- Filter IPv4 privat ketat (zod 4.6.6 tolak `010.0.0.1`, spasi, newline).
- Token tidak di isi pesan; header `authorization` diredaksi (`lib/logger.ts:76`).

## P2
1. `bridge.ts:44`, `protocol.md:25`: `void` ikut dedupe; void gagal transport diputar ulang selamanya. Dedupe hanya `sale`.
2. `protocol.md:19` vs `:25`: jurnal dihapus sesudah ack padahal dedupe butuh hasil pertama.
3. `bridge.ts:248-253`: kunci dedupe terminal+op+trace; trace 6 digit berputar bisa replay "approved" lama ke sale baru.
4. `bridge.ts:160`, `protocol.md:15,26`: `expiresAt` jam cloud; jam tablet mundur atau lease pindah = dua tablet ke satu EDC.
5. `protocol.md:23,33`: aturan cloud terima `result` hanya untuk `commandId` yang dikirim ke perangkat itu, dan pencocokan dibatasi tenant/outlet, belum ada.

## P3
Test batas IP (172.15.x, 172.31.255.255, 192.169.x, 0.0.0.0, 100.64.x), refusal `terminal_busy`; tolak IP interface tablet sendiri; batas 5 kali salah per IP/perangkat.

## Keputusan CTO 27 Nov (paling ketat)
1. Dedupe hanya `sale`. `void`/`cancel`/`inquiry` selalu ke terminal.
2. Catatan dedupe terpisah dari antrean unacked; disimpan minimal 48 jam dan sampai settlement tercocok.
3. Jurnal simpan SHA-256 frame; replay hanya bila hash sama; trace sama + hash beda = `refused trace_conflict` (jadi unknown). Test wajib.
4. Ganti `expiresAt` ke `ttlMs` relatif (dihitung tablet dari saat terima). Cloud tidak memberi lease terminal itu ke tablet lain sebelum `issuedAt + ttlMs + timeoutMs maks + 30 s` menurut jam cloud.
5. Tulis aturan: `result` diterima hanya bila `commandId` dikirim ke deviceId itu dan terminalId/op/trace/replayOf sama dengan perintah tersimpan; hasil terlambat dicocokkan dalam tenant+outlet+terminal saja. Test wajib di B2 (dicatat di bead wasr7.21).
6. P3 dibetulkan semua di B1.

## Re-review 27 Nov (4c9021c55): GAGAL ringan
Keputusan 1, 3, 4, 5, 6 terpenuhi. Sisa:
- P2 keputusan 2: jembatan tidak tahu kapan settlement tercocok. CTO: downlink `sale_record_release` {terminalId, traces[]} dikirim cloud sesudah pencocokan settlement; jembatan hapus catatan bila (lewat 48 jam DAN sudah menerima release) ATAU lewat 30 hari (batas keras penyimpanan, hello melaporkan jumlah catatan tertahan). Test parse.
- P3 `bridge.ts:301`: `EdcBridgeSaleRecord.answer: EdcBridgeAnswer | null`.
- P3 doc:30: `issuedAt` = lease/perpanjangan terakhir untuk terminal itu; cloud tidak mengirim perintah bila sisa lease < 30 s.
