# 1111 Second opinion POS kasir tiket + bukti edge->cloud (1096)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran (jangan akhiri giliran untuk kabar antara).

Fokus (sesudah `git fetch origin`, kecualikan `':!**/meta/*snapshot.json'`): `git diff origin/ghostex/45769078...origin/ws/1096-pos-kasir-tiket-struk` (head 92f4f2323). Bila diff itu kosong/aneh, pakai `git diff a93468ca8..origin/ws/1096-pos-kasir-tiket-struk`.
Isi: legend-hpgyw tiga baca kasir (`GET /api/outlets/:outletId/pos/tickets/{customers,products,slots}`, izin `pos.sale.create`, batas laju 30/menit per kasir, customers hanya id+name, min 3 karakter, maks 10); legend-ain0/ol6v jual offline + void offline edge->cloud (tanpa deadlock `RECEIPT_VOID_UNMATCHED`, replay idempoten) dan stempel `edge_reported_at` (hanya saat `lastNumber` naik, run terikat edge belum pensiun, `GREATEST` dengan jam aplikasi).

Diterima CTO (jangan dilaporkan): slot kasir murni 403 sampai legend-tkxhs; 4 digit telepon tidak ada (hanya hash WA); batas laju per proses; sisa celah rotasi palsu legend-rh1hk; rekap struk legend-21c8n; drift db:generate legend-w8cwg.

Cari: kebocoran data pelanggan lintas tenant/outlet atau field lebih dari id+name; izin bisa dilewati (outlet di path vs token, perangkat bersama, acting staff); harga produk bisa dari klien; void offline yang mengembalikan uang dua kali atau membuat struk ganda/nomor bentrok; replay mengubah state atau uang; stempel bisa mundur atau dipalsukan edge sehingga nomor struk berulang; urutan lock/deadlock edge ingest.

Hasil: tulis `docs/qa/second-opinion-pos-edge-1111.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
