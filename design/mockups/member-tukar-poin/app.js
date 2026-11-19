window.ui = {
  button(label, state, kind = "primary") {
    return `<button type="button" class="btn ${kind}" data-state="${state}">${label}</button>`;
  },
  note(text, kind = "info") {
    return `<div class="note ${kind}">${text}</div>`;
  },
  bill() {
    return `<section class="bill-context"><div class="row between"><h3>Cafe Legend</h3><span class="pill">Terhubung</span></div><p>Kemang</p><p class="bill-id">Tagihan #LG-0248 · Meja 08</p><dl class="bill-rows"><div class="row between"><dt>Total tagihan</dt><dd>Rp185.000</dd></div><div class="row between"><dt>Sudah dibayar</dt><dd>Rp0</dd></div><div class="row between strong"><dt>Sisa tagihan</dt><dd>Rp185.000</dd></div></dl></section>`;
  },
  qr() {
    let blocks = "";
    for (let y = 0; y < 29; y++)
      for (let x = 0; x < 29; x++) {
        const finder = [
          [0, 0],
          [22, 0],
          [0, 22],
        ].some(
          ([a, b]) =>
            x >= a &&
            x < a + 7 &&
            y >= b &&
            y < b + 7 &&
            (x === a ||
              x === a + 6 ||
              y === b ||
              y === b + 6 ||
              (x >= a + 2 && x <= a + 4 && y >= b + 2 && y <= b + 4)),
        );
        const safe = [
          [0, 0],
          [21, 0],
          [0, 21],
        ].some(([a, b]) => x >= a && x < a + 8 && y >= b && y < b + 8);
        if (finder || (!safe && (x * 19 + y * 7 + x * y) % 11 < 5))
          blocks += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }
    return `<div class="qr-wrap"><div class="qr"><svg viewBox="-2 -2 33 33" role="img" aria-label="Ilustrasi QR, bukan kode transaksi"><rect x="-2" y="-2" width="33" height="33" fill="white"/><g fill="#2b211b">${blocks}</g></svg></div><p class="qr-caption">QR contoh · Tidak untuk transaksi</p></div>`;
  },
};
const labels = {
  "tagihan-aktif": "Tagihan aktif",
  "pilih-poin": "Pilih poin",
  "qr-aktif": "QR aktif",
  "tanpa-tagihan": "Tanpa tagihan",
  "poin-kurang": "Poin kurang",
  "qr-kedaluwarsa": "QR kedaluwarsa",
  offline: "Offline",
  gagal: "Gagal memuat",
  "sudah-dipakai": "Sudah dipakai",
  loading: "Memuat",
  "perbandingan-alur": "Perbandingan alur",
  "kode-tagihan": "Kode tagihan",
};
Object.assign(labels, {
  "qr-member": "QR identitas member",
  "poin-setelah": "Poin setelah penukaran",
  "kode-hasil": "Konfirmasi kode tagihan",
});
const params = new URLSearchParams(location.search);
const state = params.get("state") || "tagihan-aktif";
document.body.dataset.state = state;
const requested = Number(params.get("points") || 500);
let selected =
  Number.isInteger(requested) && requested >= 1 && requested <= 1240
    ? requested
    : 500;
const number = (value) => value.toLocaleString("id-ID");
const view = window.memberViews[state] || window.memberViews["tagihan-aktif"];
document.querySelector("#screen").innerHTML = view(window.ui);
function updateAmounts(points) {
  const root = document.querySelector("#screen");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const replacements = [
    ["Rp135.000", `Rp${number(185000 - points * 100)}`],
    ["Rp50.000", `Rp${number(points * 100)}`],
    ["740 poin", `${number(1240 - points)} poin`],
    ["500 poin", `${number(points)} poin`],
  ];
  const mapping = new Map(replacements);
  while (walker.nextNode()) {
    walker.currentNode.textContent = walker.currentNode.textContent.replace(
      /Rp135\.000|Rp50\.000|740 poin|500 poin/g,
      (matched) => mapping.get(matched),
    );
  }
  const field = document.querySelector("#redeem-points");
  if (field) field.value = points;
}
if (
  [
    "pilih-poin",
    "qr-aktif",
    "qr-kedaluwarsa",
    "sudah-dipakai",
    "poin-setelah",
  ].includes(state)
)
  updateAmounts(selected);
if (["pilih-poin", "qr-aktif"].includes(state)) {
  const grid = document.querySelector("#screen > .flow-grid");
  const context = grid.querySelector(":scope > .context");
  const panel = grid.querySelector(":scope > .panel");
  const glance = document.createElement("div");
  glance.className = "order-glance";
  glance.innerHTML = `<strong>Cafe Legend · Kemang</strong><p>Tagihan #LG-0248 · Meja 08</p><div class="row between"><span>Sisa tagihan</span><strong>Rp185.000</strong></div>${state === "qr-aktif" ? `<p><strong>${number(selected)} poin · Rp${number(selected * 100)}</strong></p>` : "<p>Saldo tersedia: 1.240 poin</p>"}`;
  panel.firstElementChild.after(glance);
  const narrow = matchMedia("(max-width:700px)");
  const disclosure = document.createElement("details");
  disclosure.className = "bill-disclosure";
  disclosure.innerHTML = "<summary>Rincian tagihan dan poin</summary>";
  const arrange = () => {
    if (narrow.matches) {
      grid.append(disclosure);
      disclosure.append(context);
    } else {
      grid.prepend(context);
      disclosure.remove();
    }
  };
  arrange();
  narrow.addEventListener("change", arrange);
}
if (["sudah-dipakai", "poin-setelah"].includes(state)) {
  for (const link of document.querySelectorAll("header a, .back")) {
    const next = new URL(location.href);
    next.searchParams.set("state", "poin-setelah");
    link.href = next.href;
  }
}
const field = document.querySelector("#redeem-points");
if (field) {
  const error = document.createElement("p");
  error.id = "point-validation";
  error.className = "error-text";
  error.setAttribute("role", "alert");
  field.parentElement.append(error);
  field.setAttribute("aria-describedby", "points-limit point-validation");
  field.addEventListener("input", () => {
    const value = Number(field.value);
    const valid =
      field.value !== "" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 1240;
    field.setAttribute("aria-invalid", String(!valid));
    const mint = document.querySelector('[data-state="qr-aktif"]');
    mint.disabled = !valid;
    error.textContent = valid
      ? ""
      : "Masukkan 1 sampai 1.240 poin dalam bilangan bulat.";
    if (valid) {
      selected = value;
      const summary = document.querySelector(
        '[aria-label="Rincian penukaran"]',
      );
      summary.innerHTML = `<div class="row between"><span>Nilai ${number(value)} poin</span><strong>Rp${number(value * 100)}</strong></div><div class="row between"><span>Sisa bayar setelah dipakai</span><strong>Rp${number(185000 - value * 100)}</strong></div><div class="row between"><span>Perkiraan sisa poin</span><strong>${number(1240 - value)} poin</strong></div>`;
      mint.textContent = `Buat QR untuk ${number(value)} poin`;
      document.querySelector(".note").textContent =
        `QR berikutnya hanya untuk tagihan ini dan ${number(value)} poin. Poin dipotong setelah penukaran berhasil di kasir.`;
    }
  });
}
document.title = `${labels[state] || labels["tagihan-aktif"]} · Tukar poin · Cafe Legend`;
document.querySelector("#state-links").innerHTML = Object.entries(labels)
  .map(
    ([key, label]) =>
      `<a href="?state=${key}" ${key === state ? 'aria-current="page"' : ""}>${label}</a>`,
  )
  .join("");
document.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-state]");
  if (!button || button.disabled) return;
  const next = new URL(location.href);
  next.searchParams.set("state", button.dataset.state);
  next.searchParams.set("points", selected);
  location.href = next.href;
});
if (state === "qr-aktif" && params.get("capture") !== "1") {
  let remaining = 120;
  const clock = document.querySelector(".summary .amount");
  clock.setAttribute("role", "timer");
  const ticker = setInterval(() => {
    remaining -= 1;
    clock.textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    if (remaining <= 0) {
      clearInterval(ticker);
      const next = new URL(location.href);
      next.searchParams.set("state", "qr-kedaluwarsa");
      location.href = next.href;
    }
  }, 1000);
}
