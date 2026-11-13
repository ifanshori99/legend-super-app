const params = new URLSearchParams(location.search);
const aliases = { "source-inactive": "inactive-source", approval: "normal" };
let state = aliases[params.get("state")] || params.get("state") || "normal";
let view =
  params.get("view") ||
  (params.get("state") === "approval"
    ? "approval"
    : state === "inactive-source"
      ? "settings"
      : state === "unknown"
        ? "status"
        : "runs");
const views = [
  ["runs", "Siap bayar"],
  ["approval", "Persetujuan"],
  ["status", "Status karyawan"],
  ["settings", "Pengaturan PT"],
];
const page = document.querySelector("#page");
const button = (text, action, primary = false, disabled = false) =>
  `<button class="button ${primary ? "primary" : ""}" data-action="${action}" ${disabled ? "disabled" : ""}>${text}</button>`;
const badge = (text, type = "") => `<span class="badge ${type}">${text}</span>`;
const notice = (title, text, kind = "") =>
  `<div class="notice ${kind}" role="${kind === "error" ? "alert" : "status"}"><span class="notice-icon" aria-hidden="true">${kind === "success" ? "✓" : "!"}</span><div><strong>${title}</strong><p>${text}</p></div></div>`;
const scope = `<div class="scope"><label for="entity">Badan usaha</label><select id="entity"><option>PT Legend Kuliner</option><option>PT Legend Nusantara</option></select><span class="muted">Pengaturan dan pencairan berlaku per PT.</span></div>`;
const offNotice = () =>
  notice(
    "Duitku belum aktif untuk PT ini",
    'Gunakan transfer manual dengan persetujuan dua orang. Duitku dapat diaktifkan setelah akun, deposit, dan uji sandbox siap. <a href="?view=settings&state=duitku-off">Lihat pengaturan PT</a>.',
  );
const sourceNotice = () =>
  notice(
    "Rekening sumber tidak aktif — pencairan ditolak",
    "BCA Operasional •••• 4821 tidak dapat digunakan. Pilih rekening aktif pada pengaturan PT, lalu ajukan ulang untuk persetujuan.",
    "error",
  );
const employees = [
  {
    name: "Alya Putri",
    role: "Supervisor · Kemang",
    bank: "BCA •••• 0912",
    amount: "5.800.000",
    status: "Menunggu",
    type: "wait",
    detail: "Belum dibayar",
  },
  {
    name: "Bima Pratama",
    role: "Barista · Kemang",
    bank: "Mandiri •••• 6204",
    amount: "4.700.000",
    status: "Berhasil",
    type: "ok",
    detail: "14 Nov, 09.42 · TRF-1411-07",
  },
  {
    name: "Citra Lestari",
    role: "Kasir · Senopati",
    bank: "BCA •••• 7143",
    amount: "5.500.000",
    status: "Gagal",
    type: "fail",
    detail: "Rekening tujuan ditolak bank",
  },
  {
    name: "Dimas Saputra",
    role: "Koki · Senopati",
    bank: "BNI •••• 3508",
    amount: "5.500.000",
    status: "Dibayar manual",
    type: "manual",
    detail: "Bukti diverifikasi · TRF-1411-08",
  },
];

function summary(approval = false) {
  return `<section class="panel summary-panel"><p class="eyebrow">${approval ? "RINCIAN PENCAIRAN" : "RUN TERPILIH · NOVEMBER"}</p><p class="muted small">Gaji diterima 4 karyawan</p><div class="summary-amount">Rp21.500.000</div><div class="summary-lines"><div class="summary-line"><span>Metode pembayaran</span><strong>Transfer manual</strong></div><div class="summary-line"><span>Rekening sumber</span><strong>BCA •••• 4821</strong></div><div class="summary-line"><span>Biaya PT (perkiraan)</span><strong>Rp20.000</strong></div><div class="summary-line"><span>Total dana disiapkan</span><strong>Rp21.520.000</strong></div></div><p class="summary-note">Biaya Rp5.000 per transfer ditanggung PT. Gaji karyawan diterima utuh. Biaya manual aktual mengikuti bank dan dicatat terpisah.</p>${approval ? `<div class="action-box"><label class="checkbox"><input type="checkbox" id="checked" /><span>Saya telah memeriksa penerima, nominal, rekening sumber, dan biaya PT.</span></label>${button("Verifikasi & setujui", "approve", true, true)}<p class="compact-note">Persetujuan oleh orang selain pembuat, dengan verifikasi MFA. Berlaku 24 jam.</p></div>` : `<div class="action-box">${button("Tinjau persetujuan", "approval", true)}</div>`}</section>`;
}

function runs() {
  return `${scope}${state === "inactive-source" ? sourceNotice() : ""}${offNotice()}<div class="split"><section class="panel"><div class="panel-head"><div><h2>Run siap bayar</h2><p>Run terkunci dan belum selesai dibayar.</p></div>${badge("2 run")}</div><article class="run"><div><div class="run-meta">${badge("Menunggu persetujuan", "wait")}<span class="muted small">PAY-2026-11-01</span></div><h3>Gaji November 2026</h3><p>4 karyawan · Kemang &amp; Senopati</p><p>Diajukan Rani Wulandari · 14 Nov, 09.15</p></div><div class="run-right"><div><strong class="amount">Rp21.500.000</strong><span class="muted small">Gaji bersih</span></div>${button("Tinjau", "approval", true)}</div></article><article class="run"><div><div class="run-meta">${badge("Siap disiapkan")}<span class="muted small">PAY-2026-11-02</span></div><h3>Gaji tambahan November</h3><p>2 karyawan · Kemang</p><p>Run dikunci 14 Nov, 08.30</p></div><div class="run-right"><div><strong class="amount">Rp3.200.000</strong><span class="muted small">Gaji bersih</span></div>${button("Siapkan", "prepare")}</div></article><div class="rule"><strong>Pembuat dan penyetuju harus berbeda.</strong><br />Uang baru boleh keluar setelah pemeriksaan orang kedua. Run yang sudah lunas tidak masuk daftar ini.</div></section>${summary()}</div>`;
}

function approval() {
  const inactive = state === "inactive-source";
  return `${scope}${inactive ? sourceNotice() : ""}<div class="approval-grid"><section class="panel"><div class="panel-head"><div><p class="eyebrow">PAY-2026-11-01 · TRANSFER MANUAL</p><h2>Periksa sebelum menyetujui</h2><p>Gaji November 2026 · 4 karyawan</p></div>${badge("1 dari 2 orang", "wait")}</div><div class="timeline"><div class="person"><span>01 · Pembuat pengajuan</span><strong>Rani Wulandari</strong><span>14 Nov 2026, 09.15 WIB</span>${badge("✓ Sudah diajukan", "ok")}</div><div class="person pending"><span>02 · Penyetuju berbeda</span><strong>Anda · Arif Wijaya</strong><span>Manajer keuangan</span>${badge("Menunggu verifikasi", "wait")}</div></div><table class="table"><thead><tr><th>Karyawan</th><th>Rekening tujuan</th><th>Gaji diterima</th></tr></thead><tbody>${employees.map((e) => `<tr><td><strong>${e.name}</strong><span class="secondary">${e.role}</span></td><td data-label="Rekening">${e.bank}</td><td data-label="Gaji"><span class="amount">Rp${e.amount}</span></td></tr>`).join("")}</tbody></table><div class="rule"><strong>Periksa nama penerima di internet banking.</strong><br />Jalur manual tidak memeriksa nama pemilik rekening otomatis. Gunakan rekening yang telah dikunci bersama run.</div><p class="compact-note">Setelah transfer, hasil dan bukti per karyawan harus dikonfirmasi oleh orang selain pembuat. Format berkas bank menyusul setelah rilis.</p></section>${summary(true)}</div>`;
}

function statusPage() {
  const unknown = state === "unknown";
  const rows = employees
    .map((e, i) => {
      const uncertain = unknown && i === 0;
      return `<tr><td><strong>${e.name}</strong><span class="secondary">${e.bank}</span></td><td data-label="Gaji diterima"><span class="amount">Rp${e.amount}</span></td><td>${badge(uncertain ? "Status belum pasti" : e.status, uncertain ? "wait" : e.type)}<span class="secondary">${uncertain ? "Hasil bank belum diketahui · Jangan kirim ulang" : e.detail}</span></td><td>${i === 0 ? button(uncertain ? "Periksa status" : "Catat hasil manual", uncertain ? "check-status" : "manual-result") : i === 1 ? button("Lihat rincian", "success-detail") : i === 2 ? button("Tinjau kegagalan", "failure") : button("Lihat bukti", "evidence")}</td></tr>`;
    })
    .join("");
  return `${scope}<div class="status-heading"><div class="status-top"><div><p class="eyebrow">PAY-2026-11-01</p><h2>Gaji November 2026</h2><p class="muted small">Hasil per karyawan · Terakhir diperbarui 14 Nov, 10.08 WIB</p></div>${badge("Belum lunas", "wait")}</div></div>${unknown ? notice("Hasil transfer belum pasti", "Jangan bayar ulang atau tandai gagal. Periksa status dan bukti bank terlebih dahulu. Penyelesaian manual memerlukan dua orang berbeda.") : ""}<div class="stats"><div class="stat"><p>${unknown ? "Belum pasti" : "Menunggu"}</p><strong>1</strong><small>Rp5.800.000</small></div><div class="stat"><p>Berhasil</p><strong>1</strong><small>Rp4.700.000</small></div><div class="stat"><p>Gagal</p><strong>1</strong><small>Rp5.500.000</small></div><div class="stat"><p>Dibayar manual</p><strong>1</strong><small>Rp5.500.000</small></div></div><section class="panel"><div class="panel-head"><div><h2>Hasil pencairan</h2><p>Rp10.200.000 telah diterima · Rp11.300.000 belum selesai</p></div>${button("Segarkan", "refresh")}</div><table class="table status-table"><thead><tr><th>Karyawan</th><th>Gaji diterima</th><th>Status</th><th>Tindak lanjut</th></tr></thead><tbody>${rows}</tbody></table><p class="compact-note">Karyawan yang berhasil atau dibayar manual tidak boleh dibayar ulang. Pengajuan baru hanya untuk kegagalan yang sudah dipastikan.</p></section>`;
}

function settings() {
  const inactive = state === "inactive-source";
  return `${scope}${inactive ? sourceNotice() : ""}<div class="settings-grid"><section class="panel"><div class="panel-head"><div><h2>Pengaturan pencairan PT</h2><p>PT Legend Kuliner</p></div>${badge("Transfer manual", "manual")}</div><div class="setting-section"><div class="fields"><div class="field full"><label for="method">Metode pembayaran</label><select id="method"><option value="manual">Transfer manual</option><option value="duitku">Duitku disbursement · Belum aktif</option></select><p>Persetujuan dua orang berlaku untuk semua metode.</p></div><div class="field full"><label for="source">Rekening sumber manual</label><select id="source" class="${inactive ? "invalid" : ""}" ${inactive ? 'aria-invalid="true" aria-describedby="source-error"' : ""}><option value="bca">BCA Operasional •••• 4821${inactive ? " · Tidak aktif" : " · Aktif"}</option><option value="mandiri">Mandiri Operasional •••• 9075 · Aktif</option></select><p ${inactive ? 'id="source-error" class="invalid-text"' : ""}>${inactive ? "Pencairan ditolak. Pilih rekening aktif milik PT ini." : "Dipakai untuk transfer manual, termasuk cadangan saat Duitku tidak tersedia."}</p></div><div class="field"><label for="cap">Batas per transfer (Rp)</label><input id="cap" inputmode="numeric" value="50.000.000" /><p>Di atas batas, alihkan ke transfer manual.</p></div><div class="field"><label for="daily">Batas harian tambahan (Rp)</label><input id="daily" inputmode="numeric" value="100.000.000" /><p>Duitku berhenti sebelum melewati batas.</p></div></div></div><div class="setting-section"><div class="panel-head"><h3>Duitku disbursement</h3>${badge("Belum aktif", "wait")}</div><p class="muted small">Kredensial khusus pencairan, terpisah dari penerimaan pembayaran. Kunci yang tersimpan tidak ditampilkan kembali.</p><div class="fields" style="margin-top:20px"><div class="field"><label for="userid">User ID Duitku</label><input id="userid" inputmode="numeric" autocomplete="off" placeholder="Belum terhubung" /></div><div class="field"><label for="email">Email akun Duitku</label><input id="email" type="email" autocomplete="off" placeholder="nama@perusahaan.id" /></div><div class="field full"><label for="secret">Secret key baru</label><input id="secret" type="password" autocomplete="new-password" placeholder="Masukkan untuk mengganti kunci" /><p>Hanya untuk pengiriman ke server; tidak pernah dibaca ulang. Mockup tidak menyimpan isian.</p></div></div><div style="margin-top:16px">${button("Simulasikan tes koneksi", "test-connection")}</div></div><div class="settings-actions"><p class="muted small">Perubahan memerlukan verifikasi MFA.</p>${button("Simpan pengaturan", "save-settings", true, inactive)}</div></section><div><section class="panel"><p class="eyebrow">ATURAN PEMBAYARAN</p><h3>Gaji karyawan tetap utuh</h3><div class="summary-lines"><div class="summary-line"><span>Biaya per transfer</span><strong>Rp5.000</strong></div><div class="summary-line"><span>Ditanggung</span><strong>PT Legend Kuliner</strong></div></div><p class="summary-note">Biaya Duitku masuk beban bank PT. Biaya transfer manual aktual mengikuti bank.</p></section><section class="panel"><h3>Aktifkan Duitku saat siap</h3><p class="compact-note">Akun pencairan, deposit, dan uji sandbox harus siap sebelum pembayaran otomatis diaktifkan untuk PT ini.</p><div class="rule">Saat ini: transfer manual tersedia. Format berkas bank ditunda setelah rilis.</div></section></div></div>`;
}

function empty() {
  const content =
    view === "settings"
      ? [
          "Belum ada pengaturan pencairan",
          "Pilih metode dan rekening sumber aktif untuk badan usaha ini sebelum menyiapkan pembayaran.",
          "Lihat contoh pengaturan",
          "settings-example",
        ]
      : view === "approval"
        ? [
            "Tidak ada persetujuan menunggu",
            "Pengajuan baru akan muncul di sini setelah pencairan disiapkan oleh pembuat yang berbeda.",
            "Kembali ke run siap bayar",
            "runs",
          ]
        : view === "status"
          ? [
              "Belum ada pencairan untuk ditampilkan",
              "Siapkan pencairan dari run gaji yang sudah dikunci. Status karyawan akan muncul setelah pengajuan dibuat.",
              "Lihat run siap bayar",
              "runs",
            ]
          : [
              "Belum ada run siap bayar",
              "Run gaji yang sudah dikunci dan belum lunas akan muncul di sini. Periksa proses penggajian sebelum menyiapkan pencairan.",
              "Lihat contoh run",
              "runs",
            ];
  return `${scope}<section class="panel empty"><div class="empty-icon" aria-hidden="true">✓</div><h2>${content[0]}</h2><p>${content[1]}</p>${button(content[2], content[3], true)}</section>`;
}

function render() {
  document.querySelector("#tabs").innerHTML = views
    .map(
      ([id, label]) =>
        `<a href="?view=${id}&state=${state}" ${view === id ? 'aria-current="page"' : ""}>${label}</a>`,
    )
    .join("");
  document.querySelector("#state").value = state;
  if (state === "empty") page.innerHTML = empty();
  else if (state === "error")
    page.innerHTML = `${scope}${notice("Data pencairan belum dapat dimuat", "Periksa koneksi, lalu coba lagi. Status pembayaran belum diketahui; jangan membuat pembayaran pengganti.", "error")}<section class="panel empty"><h2>Daftar belum tersedia</h2><p>Data gaji dan status terakhir tidak ditampilkan sampai pemuatan berhasil.</p>${button("Coba lagi", "retry", true)}</section>`;
  else if (state === "loading")
    page.innerHTML = `${scope}<section class="panel" aria-busy="true"><h2>Memuat ${view === "settings" ? "pengaturan pencairan" : view === "status" ? "status pembayaran" : view === "approval" ? "rincian persetujuan" : "run siap bayar"}</h2><p class="compact-note">Memeriksa data terbaru untuk PT Legend Kuliner…</p><div class="skeleton short"></div>${[1, 2, 3].map(() => '<div class="skeleton-row"><div class="skeleton medium"></div><div class="skeleton"></div></div>').join("")}</section>`;
  else
    page.innerHTML =
      view === "settings"
        ? settings()
        : view === "approval"
          ? approval()
          : view === "status"
            ? statusPage()
            : runs();
  if (state === "inactive-source") {
    const approve = document.querySelector('[data-action="approve"]');
    if (approve) approve.disabled = true;
  }
}

function move(nextView, nextState = "normal") {
  view = nextView;
  state = nextState;
  history.replaceState(null, "", `?view=${view}&state=${state}`);
  render();
}

function modal(title, body) {
  document.querySelector("#dialog-title").textContent = title;
  document.querySelector("#dialog-body").innerHTML =
    `<div class="dialog-body">${body}</div>`;
  document.querySelector("#dialog").showModal();
}

document.querySelector("#state").addEventListener("change", (event) => {
  const next = event.target.value;
  move(
    next === "inactive-source"
      ? "settings"
      : next === "unknown"
        ? "status"
        : view,
    next,
  );
});

document.addEventListener("change", (event) => {
  if (event.target.id === "checked")
    document.querySelector('[data-action="approve"]').disabled =
      !event.target.checked || state === "inactive-source";
  if (event.target.id === "source" && state === "inactive-source") {
    const invalid = event.target.value !== "mandiri";
    event.target.classList.toggle("invalid", invalid);
    event.target.setAttribute("aria-invalid", String(invalid));
    document.querySelector("#source-error").textContent = invalid
      ? "Pencairan ditolak. Pilih rekening aktif milik PT ini."
      : "Rekening aktif dipilih. Simpan setelah verifikasi MFA.";
    document
      .querySelector("#source-error")
      .classList.toggle("invalid-text", invalid);
    document.querySelector('[data-action="save-settings"]').disabled = invalid;
  }
  if (event.target.id === "method" && event.target.value === "duitku") {
    event.target.value = "manual";
    modal(
      "Duitku belum aktif",
      "<p>Pembayaran otomatis belum dapat digunakan untuk PT ini. Lengkapi akun, deposit, dan uji sandbox sebelum aktivasi.</p><p>Transfer manual tetap tersedia dengan pemeriksaan dua orang.</p>",
    );
  }
  if (event.target.id === "entity" && event.target.selectedIndex === 1) {
    event.target.selectedIndex = 0;
    modal(
      "Contoh badan usaha lain",
      "<p>PT Legend Nusantara belum tersedia pada simulasi ini. Pilihan dikembalikan ke PT Legend Kuliner agar data dan rekening tidak tercampur lintas PT.</p>",
    );
  }
});

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if (["runs", "approval", "status"].includes(action)) {
    move(action, state === "inactive-source" ? "inactive-source" : "normal");
    return;
  }
  if (action === "settings-example") {
    move("settings");
    return;
  }
  if (action === "retry" || action === "refresh") {
    const restoredState =
      state === "inactive-source" ? "inactive-source" : "normal";
    move(view, "loading");
    setTimeout(() => move(view, restoredState), 650);
    return;
  }
  if (action === "prepare")
    modal(
      "Siapkan gaji tambahan",
      "<p>2 karyawan · Gaji bersih Rp3.200.000 · Transfer manual.</p><p>Pada aplikasi, pengajuan akan dikirim untuk diperiksa orang kedua. Simulasi ini tidak membuat batch atau memindahkan uang.</p>",
    );
  if (action === "approve")
    modal(
      "Verifikasi orang kedua",
      '<p>Anda: Arif Wijaya · Pembuat: Rani Wulandari.</p><p>Gaji Rp21.500.000 · Perkiraan biaya PT Rp20.000. Setelah MFA berhasil, persetujuan berlaku 24 jam. Transfer manual dilakukan di internet banking, kemudian bukti diverifikasi.</p><div class="rule">Simulasi berhenti di sini. Tidak ada persetujuan atau pembayaran nyata.</div>',
    );
  if (action === "save-settings")
    modal(
      "Verifikasi perubahan pengaturan",
      "<p>Pada aplikasi, perubahan rekening dan metode memerlukan MFA. Pengaturan tidak boleh diubah selama batch aktif masih menunggu persetujuan atau sedang dibayar.</p><p>Isian pada mockup tidak dikirim atau disimpan.</p>",
    );
  if (action === "test-connection")
    modal(
      "Koneksi belum diuji",
      "<p>Ini contoh tampilan, tanpa sambungan ke Duitku. Kredensial, saldo deposit, dan kesiapan akun belum diperiksa.</p><p>Jangan masukkan kunci asli ke halaman mockup.</p>",
    );
  if (action === "manual-result")
    modal(
      "Catat hasil transfer manual",
      '<p>Alya Putri · Rp5.800.000 · BCA •••• 0912.</p><div class="field"><label for="reference">Referensi transfer bank</label><input id="reference" placeholder="Contoh: TRF-1411-09" /></div><div class="field"><label for="evidence">Bukti hasil bank</label><input id="evidence" type="file" accept=".pdf,.png,.jpg" /></div><p>Hasil baru menjadi “Dibayar manual” setelah referensi dan bukti diverifikasi oleh orang selain pembuat, dengan MFA. Simulasi ini tidak menyimpan berkas.</p>',
    );
  if (action === "failure")
    modal(
      "Tinjau kegagalan sebelum bayar ulang",
      "<p>Citra Lestari · Rp5.500.000. Bank menolak rekening tujuan.</p><p>Pastikan dana tidak terkirim dan perbaiki rekening untuk pengajuan berikutnya. Pengajuan baru harus mendapat persetujuan dua orang. Karyawan yang sudah berhasil tidak disertakan.</p>",
    );
  if (action === "check-status")
    modal(
      "Periksa status bank",
      "<p>Alya Putri · Rp5.800.000. Hasil transfer belum pasti.</p><p>Belum ada bukti bank pada simulasi. Pembayaran ulang ditahan. Penetapan gagal secara manual paling cepat hari kerja berikutnya dan memerlukan bukti serta dua orang berbeda.</p>",
    );
  if (action === "success-detail")
    modal(
      "Pembayaran berhasil",
      '<p>Bima Pratama · Mandiri •••• 6204 · Rp4.700.000.</p><p>Referensi TRF-1411-07 · 14 Nov 2026, 09.42 WIB. Gaji diterima utuh; biaya transfer ditanggung PT.</p><div class="rule">Pembayaran berhasil dikunci dari pembayaran ulang.</div>',
    );
  if (action === "evidence")
    modal(
      "Bukti pembayaran manual",
      "<p>Dimas Saputra · BNI •••• 3508 · Rp5.500.000.</p><p>Referensi TRF-1411-08 · Dikonfirmasi Arif Wijaya pada 14 Nov 2026, 10.08 WIB. Pembuat pengajuan: Rani Wulandari.</p><p>Berkas bukti adalah ilustrasi dan tidak tersedia untuk diunduh.</p>",
    );
});

render();
