# Serah terima CTO Legend, 11 Nov pagi

Kamu CTO baru (coordinator Ghostex). Sesi lama (G3wqn) sudah compact 2x. Ikuti skill ghostex-orchestrator, `~/.agents/team/TEAM.md`, `~/.agents/team/roles/cto.md`. Repo: `/Users/ifanshori99/Projects/legend super app/legend`. Sumber kebenaran: `docs/PROGRESS.md` (bagian paling bawah, 11 Nov).

## Langkah pertama
1. Buat ulang cron (session-only): retro 3 jam `43 1,4,7,10,13,16,19,22 * * *` (brief `~/.agents/team/retro-brief.md`, akun Claude 7d terendah, bukan #2); push GitHub tiap jam menit 17 (`git push origin --all`, tanpa --force, lapor hanya bila gagal).
2. Merge train G3hrs (batch48c, edacffd2) dibangunkan sesi lama; tunggu laporannya: full test, e2e, majukan m1, push.
3. Isi slot kosong dengan kartu siap:
   - legend-lgfru (A, identitas WhatsApp masuk, migrasi sementara 0270): engineer Opus high, review architect xhigh. Desain: `docs/design/whatsapp-inbound-verification.md` di `origin/ws/kirimdev-inbound-design`.
   - legend-s5rgo (D, simulator webhook + dokumen): engineer Sonnet.
   - test-writer untuk legend-9h2oj (B) boleh paralel dengan A.
   - Kartu C (ur82k layar) menunggu founder Q12; E (axmob) menunggu Q13-Q16 dan kunci produksi via `ghostex secret request`.
4. Batch48d setelah 48c masuk m1: tenant-config-followups, owner-self-approve, inbox, snhxw, outlet-followups, duitku-406 (10c6e338), ps-405, fix/codex-418-pin (gantikan payslip-pin-ui + qih2m), pti5r setelah 423, fix/codex-411 (d6a99fda, 0242), fix/codex-414, fix/codex-415 (72e909a2), fix/codex-419 (77651114 + tambahan move items).

## Thread berjalan (dari sesi lama, belum dipindah)
G2i7n 423 refund, G41dv 421 PIN, G9vme 416 HRIS, G2gcq 420 gabung meja (mengerjakan race moveSessionItemsOperation), G3hrs merge train, G0muc tidur (bangunkan setelah full suite merge train). Laporan mereka masih datang ke sesi lama; sesi lama meneruskan ringkasannya kepadamu.

## Pertanyaan founder terbuka
Q12 (page mockup lupa PIN inbound) dan Q13-Q16 (paket Kirimdev, nomor WhatsApp, aturan 7 hari, tanpa WA -> HR) ada di chat sesi lama; jawabannya diteruskan kepadamu. Tag berikut: Q17.

## Aturan baru
- Codex #2 boleh sampai 11 Nov 09:00 WIB, lalu dilarang sampai founder izinkan. Codex: #3, #4, #5.
- Retro berikut: cek kenapa 3 tsc jalan bersamaan (heavy.lock, heavy-2.lock, heavy-5.lock) saat RAM merah 05:40.
- Tiap laporan: cek sampler RAM segar (`tail -1 ~/.claude/state/ram-log.csv`).
