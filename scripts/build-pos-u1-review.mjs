// Membangun design/review/pos-u1-review.html (Ghostex page) dari PNG di design/screenshots/pos-u1/.
// Jalankan: node scripts/build-pos-u1-review.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shotDir = join(root, 'design/screenshots/pos-u1');
const outFile = join(root, 'design/review/pos-u1-review.html');

// Tiap layar: nama file dasar (tanpa -390/-1280), label untuk founder.
const groups = [
  {
    tag: 'Q1',
    title: 'Kasir utama',
    lede: 'Layar kasir untuk memilih menu, mengatur keranjang, dan menerima pesanan.',
    question: 'Apakah layar Kasir utama sudah sesuai yang Anda mau?',
    screens: [
      ['kasir-main', 'Normal: daftar menu dan keranjang'],
      ['kasir-keranjang-mobile', 'Keranjang di HP'],
      ['kasir-modifier', 'Pilihan tambahan (misalnya tingkat pedas)'],
      ['kasir-takeaway', 'Pesanan bawa pulang'],
      ['kasir-memuat', 'Sedang memuat'],
      ['kasir-kosong', 'Menu kosong'],
      ['kasir-gagal', 'Gagal memuat'],
      ['kasir-offline', 'Tanpa internet'],
    ],
  },
  {
    tag: 'Q2',
    title: 'Captain order',
    lede: 'Layar pelayan (captain) untuk melihat meja, mencatat pesanan, dan menjawab panggilan tamu.',
    question: 'Apakah layar Captain order sudah sesuai yang Anda mau?',
    screens: [
      ['captain-main', 'Daftar meja'],
      ['captain-meja-main', 'Pesanan satu meja'],
      ['captain-panggilan-main', 'Panggilan tamu'],
      ['captain-memuat', 'Daftar meja: memuat'],
      ['captain-kosong', 'Daftar meja: kosong'],
      ['captain-gagal', 'Daftar meja: gagal memuat'],
      ['captain-offline', 'Daftar meja: tanpa internet'],
      ['captain-panggilan-memuat', 'Panggilan: memuat'],
      ['captain-panggilan-kosong', 'Panggilan: kosong'],
      ['captain-panggilan-gagal', 'Panggilan: gagal memuat'],
      ['captain-panggilan-offline', 'Panggilan: tanpa internet'],
    ],
  },
];

// Hal yang sengaja berbeda dari mockup yang sudah Anda setujui.
const differences = [
  ['Nama kasir', 'Mockup menulis "Kasir 01". Di aplikasi nama itu belum bisa tampil karena datanya belum ada dari server.'],
  ['Kirim item yang ditahan', 'Bila pesanan belum dibuat, tombol ini hanya melepas tahan pada item. Layar lalu memberi tahu "N item ditahan akan dikirim bersama pesanan ini". Item baru terkirim setelah pesanan dibuat.'],
  ['Urungkan', 'Menghapus item atau menyelesaikan panggilan tamu memunculkan pemberitahuan kecil dengan tombol "Urungkan", jadi salah ketuk bisa dibatalkan. Ini tidak ada di mockup.'],
  ['Pilih meja', 'Bila meja tidak ditemukan, layar menampilkan pesan dan tombol kembali ke daftar Pilih meja, bukan layar kosong.'],
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function img(name, width, label) {
  const file = join(shotDir, `${name}-${width}.png`);
  if (!existsSync(file)) return null;
  const b64 = readFileSync(file).toString('base64');
  return `<img src="data:image/png;base64,${b64}" alt="${esc(label)} (${width} px)">`;
}

function figure(name, label) {
  const phone = img(name, 390, label);
  const desktop = img(name, 1280, label);
  if (!phone && !desktop) return '';
  return `
    <figure class="gx-figure">
      <figcaption><b>${esc(label)}</b></figcaption>
      <div class="pair">
        ${phone ? `<div class="shot phone"><small>HP (390)</small>${phone}</div>` : ''}
        ${desktop ? `<div class="shot desk"><small>Layar lebar (1280)</small>${desktop}</div>` : ''}
      </div>
    </figure>`;
}

const groupHtml = groups
  .map((g) => `
  <h2>${esc(g.title)}</h2>
  <p>${esc(g.lede)}</p>
  <gx-wide>${g.screens.map(([n, l]) => figure(n, l)).join('')}
  </gx-wide>`)
  .join('\n');

const questionHtml = groups
  .map((g) => `
  <gx-question tag="${g.tag}" title="${esc(g.question)}">
    <gx-choice value="setujui">Setujui<small>Sudah sesuai, boleh dilanjutkan.</small></gx-choice>
    <gx-choice value="ubah">Ubah<small>Ada yang perlu diubah. Tulis di kolom catatan.</small></gx-choice>
  </gx-question>`)
  .join('\n');

const diffHtml = differences
  .map(([t, d]) => `<li><b>${esc(t)}.</b> ${esc(d)}</li>`)
  .join('\n      ');

const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="ghostex-page" content="v2">
<title>Review tampilan Kasir dan Captain (U1)</title>
<style>
  /* HP dan layar lebar berdampingan; di HP ditumpuk. */
  .pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2.4fr); gap: 12px; align-items: start; }
  @media (max-width: 600px) { .pair { grid-template-columns: minmax(0, 1fr); } }
  .shot { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .shot small { font-size: 11px; color: var(--gx-muted); }
  .shot img { width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--gx-line); }
  .shot.phone img { max-width: 300px; }
</style>
</head>
<body>
<gx-questions submit="Kirim ke tim">
  <header>
    <span class="gx-eyebrow">Review desain · POS</span>
    <h1>Review tampilan Kasir dan Captain (U1)</h1>
    <p class="gx-lede">Ini hasil jadi dari mockup yang sudah Anda setujui. Lihat tiap kelompok, lalu pilih Setujui atau Ubah.</p>
    <div class="gx-chips">
      <span class="gx-chip"><b>2</b> kelompok layar</span>
      <span class="gx-chip"><b>${differences.length}</b> beda dari mockup</span>
    </div>
  </header>
${groupHtml}

  <h2>Beda dari mockup</h2>
  <p>Hal-hal ini sengaja tidak sama persis dengan mockup. Mohon dicek.</p>
  <div class="gx-callout" data-tone="warn">
    <ul>
      ${diffHtml}
    </ul>
  </div>
${questionHtml}
</gx-questions>
</body>
</html>
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`Ditulis ${outFile} (${(Buffer.byteLength(html) / 1048576).toFixed(2)} MiB)`);
