# Brief: fix review architect — ws/procurement (legend-9yz, legend-25a7)

Cabang `ws/procurement` (HEAD ab1ca06), worktree `.worktrees/procurement`. Tidak ada blocker; kerjakan semua temuan di bawah dengan test yang gagal sebelum fix. Merge `main` dulu. Pastikan `node_modules` bukan symlink (legend-meki).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (file tidak bertumpuk).

1. **Medium purchasing-send.service.ts:442-448, endpoints.ts:265** — PO bisa dikirim ke email mana saja, resend tanpa batas. Fix: default penerima = email/kontak supplier; alamat bebas butuh `purchasing.supplier.manage`; batasi resend (rate limit per PO).
2. **Low-medium** — `revoked_at` tidak pernah ditulis. Fix: endpoint revoke link; cabut semua link saat PO closed/cancelled.
3. **Low purchasing-order.service.ts:637-643, :759** — peminta PR bisa menyetujui PO dari PR-nya. Fix: tolak `requestedBy` PR sebagai approver PO di jalur manual dan settle.
4. **Low** — jumlah sangat besar memicu `RangeError` jadi 500 (`priceLines` :175-188, totals :283); `lines` tanpa `.max()` padahal `line_no` smallint. Fix: map `RangeError` ke 422; `lines.max(200)`.
5. **Low order.service :603-605, request.service :430-431** — replay idempotensi sebelum cek izin/outlet. Fix: klaim setelah `lockOrder` dan `requireOpsPermission`.
6. **Low order.service :594** — payload replay disimpan dengan `outlet_id` null. Fix: isi `outlet_id` setelah lock.

## Bukti selesai
Test terkait lulus, `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` lulus, `git status` bersih, subagent reviewer konteks segar cek diff. Commit lokal merujuk legend-9yz/legend-25a7. Jangan push, jangan merge. Lapor per temuan.
