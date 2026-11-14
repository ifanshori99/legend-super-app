# 861 EDC failover dan receipt-run (engineer Sonnet, uang)

Langkah 0: `git log --all --oneline --grep=<id>`; sudah ada: lapor. Pastikan base memuat kode kartu (`git merge-base --is-ancestor`).

- legend-r11em: EDC failover: proses kedua setelah kunci outlet hilang menghapus sale_wire_open_at milik proses lama; gagal tulis marker + adapter abaikan abort hanya dilindungi jendela 10 menit (architect 830 ronde 3). Cabang fix/edc-failover-861 dari fix/edc-so-829.
- legend-n2d3g: receipt-run tertahan selamanya bila order.paid/placed di-dead-letter (btx4d). Cari cabang yang memuat btx4d (`git log --all --grep=btx4d`); cabang fix/receipt-run-861, worktree terpisah.

Jangan sampai rugi: test bahwa kartu tidak tertagih dua kali dan sale terbuka tidak hilang. Ragu: pilih yang membatasi pembayaran, tanya CTO.
Migrasi bila perlu: rentang 0449-0450, lapor dulu.
Review: satu subagent architect effort xhigh (uang). Pra-gate AGENTS.md. Commit + push tanpa force. Klaim kartu bd, jangan close. Lapor sha, test, review, angka subagent.
