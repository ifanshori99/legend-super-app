// Customer surface (Hangat): QR menu, item sheet, cart — v1 vs v2.
// BEFORE uses the shipped CustomerShell and the v1 composition (letter tiles,
// outlined chips, one bordered card per row). AFTER is the v2 direction:
// photo-first plates, ink filter chips, one accent surface (the cart bar),
// tint-pill active nav, surface-2 bands, scaled money.
import {
  ArrowLeft,
  ArrowRight,
  Armchair,
  Check,
  ClipboardList,
  Heart,
  Info,
  Minus,
  Plus,
  ReceiptText,
  Search,
  ShoppingBasket,
  Trash2,
  UtensilsCrossed,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import { CustomerShell } from "@/components/shells/customer-shell";
import { ThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { MediaPlate } from "@/components/ui/media-plate";
import { Money } from "@/components/ui/money";
import { Compare, Screen, Stage, type CompareView } from "./frame";
import {
  v2Cart,
  v2Categories,
  v2Coffee,
  v2Featured,
  v2Food,
  type SampleItem,
} from "./sample";

const BRAND = "Cafe Legend";
const NAV: { label: string; icon: LucideIcon }[] = [
  { label: "Menu", icon: UtensilsCrossed },
  { label: "Keranjang", icon: ShoppingBasket },
  { label: "Pesanan", icon: ClipboardList },
  { label: "Tagihan", icon: ReceiptText },
];
const SCREEN = "h-[844px] w-full max-w-[400px] justify-self-center";
// The menu frame shows the whole scroll (long screenshot), not one viewport.
const LONG = "w-full max-w-[400px] justify-self-center";
const cartCount = v2Cart.reduce((n, line) => n + line.qty, 0);
const cartTotal = v2Cart.reduce((n, line) => n + line.qty * line.unit, 0);

export function CustomerCompare({
  view,
  tenant,
}: {
  view: CompareView;
  tenant?: string;
}) {
  return (
    <Compare
      view={view}
      before={
        <Stage
          tag="before"
          title="QR menu, detail item, keranjang"
          note="Seperti yang dikirim hari ini: kartu huruf, chip bergaris, satu kartu berbingkai per baris, aksen hanya di tombol."
        >
          <div className="grid gap-6 xl:grid-cols-3">
            <Screen label="Menu (seluruh halaman)" className={LONG}>
              <BeforeMenu />
            </Screen>
            <Screen label="Detail item" className={SCREEN}>
              <BeforeSheet />
            </Screen>
            <Screen label="Keranjang" className={SCREEN}>
              <BeforeCart />
            </Screen>
          </div>
        </Stage>
      }
      after={
        <Stage
          tag="after"
          title="QR menu, detail item, keranjang"
          note="Foto dulu, satu permukaan aksen per layar (bilah keranjang / tombol utama), chip tinta netral, band surface-2, angka uang berjenjang."
        >
          <ThemeScope
            tenant={tenant}
            density="hangat"
            className="grid gap-6 xl:grid-cols-3"
          >
            <Screen label="Menu (seluruh halaman)" className={LONG}>
              <AfterMenu />
            </Screen>
            <Screen label="Detail item" className={SCREEN}>
              <AfterSheet />
            </Screen>
            <Screen label="Keranjang" className={SCREEN}>
              <AfterCart />
            </Screen>
          </ThemeScope>
        </Stage>
      }
    />
  );
}

/* ------------------------------------------------------------ BEFORE */

function beforeNav(current: number) {
  return NAV.map((item, index) => ({
    label: item.label,
    icon: item.icon,
    href: "#pelanggan",
    current: index === current,
    count: index === 1 ? cartCount : undefined,
  }));
}

function LetterTile({ name, className }: { name: string; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid place-items-center rounded-xl bg-muted text-3xl font-bold text-muted-foreground",
        className,
      )}
    >
      {name.charAt(0)}
    </div>
  );
}

function BeforeMenu() {
  return (
    <CustomerShell
      embedded
      brandName={BRAND}
      context="Meja A01"
      actions={
        <Button variant="outline" size="sm">
          Masuk
        </Button>
      }
      nav={beforeNav(0)}
    >
      <p className="text-3xl leading-9 font-bold tracking-tight">Menu</p>
      <p className="mt-1 text-muted-foreground">
        Indoor Reguler · Bayar di muka · 2 tamu
      </p>
      <div className="mt-4 flex h-12 items-center gap-2 rounded-field border border-input px-3 text-muted-foreground">
        <Search aria-hidden="true" /> Cari nama atau deskripsi menu
      </div>
      <div className="mt-3 flex gap-2 overflow-hidden">
        {v2Categories.map((label, index) => (
          <span
            key={label}
            className={cn(
              "inline-flex h-11 shrink-0 items-center gap-1 rounded-full border border-input px-4",
              index === 0 && "bg-accent",
            )}
          >
            {index === 0 && <Check className="size-4" aria-hidden="true" />}
            {label}
          </span>
        ))}
      </div>
      <p className="mt-6 text-lg font-semibold">Disarankan untuk Anda</p>
      <div className="mt-2 flex gap-3 overflow-hidden">
        {v2Featured.slice(0, 3).map((item) => (
          <div
            key={item.id}
            className="w-44 shrink-0 rounded-2xl border bg-card p-3"
          >
            <LetterTile name={item.name} className="h-28" />
            <p className="mt-3 line-clamp-2 font-semibold">{item.name}</p>
            <div className="mt-2 flex items-center justify-between">
              <Money amount={item.price} className="font-semibold" />
              <span className="grid size-11 place-items-center rounded-full border border-input">
                <Plus aria-hidden="true" />
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-6 text-2xl font-semibold">Kopi</p>
      <ul className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3">
        {[...v2Coffee, ...v2Food].map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-2xl border bg-card p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{item.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                {item.description}
              </p>
              <Money amount={item.price} className="mt-1 block font-semibold" />
            </div>
            <Button size="icon-sm" aria-label={`Tambah ${item.name}`}>
              <Plus aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </CustomerShell>
  );
}

function BeforeSheet() {
  const item = v2Coffee[0]!;
  return (
    <div className="flex h-full flex-col bg-scrim pt-20">
      <div className="flex min-h-0 flex-1 flex-col rounded-t-2xl bg-card">
        <div className="flex justify-end p-3">
          <X aria-hidden="true" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-6">
          <LetterTile name={item.name} className="h-44" />
          <p className="mt-4 text-xl font-semibold">{item.name}</p>
          <p className="mt-1 text-muted-foreground">{item.description}</p>
          {[
            ["Pilih varian", ["Dingin", "Panas"]],
            ["Tingkat gula", ["Normal", "Kurang"]],
          ].map(([title, options]) => (
            <div key={title as string} className="mt-5">
              <div className="flex justify-between">
                <p className="font-semibold">{title}</p>
                <p className="text-sm text-muted-foreground">Wajib · Pilih 1</p>
              </div>
              {(options as string[]).map((option) => (
                <div
                  key={option}
                  className="mt-2 flex h-12 items-center gap-3 rounded-xl border px-4"
                >
                  <span className="size-5 rounded-full border-2 border-input" />
                  {option}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="grid gap-3 border-t p-5">
          <div className="flex items-center gap-4">
            <span className="grid size-11 place-items-center rounded-full border border-input">
              <Minus aria-hidden="true" />
            </span>
            <span className="tabular">1</span>
            <span className="grid size-11 place-items-center rounded-full border border-input">
              <Plus aria-hidden="true" />
            </span>
            <Money
              amount={item.price}
              className="ms-auto text-xl font-semibold"
            />
          </div>
          <Button className="w-full">Tambah ke keranjang</Button>
        </div>
      </div>
    </div>
  );
}

function BeforeCart() {
  return (
    <CustomerShell
      embedded
      brandName={BRAND}
      context="Meja A01"
      nav={beforeNav(1)}
    >
      <p className="text-3xl leading-9 font-bold tracking-tight">
        Keranjang meja
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Dilihat semua tamu di meja ini dan diperbarui otomatis.
      </p>
      <ul className="mt-4 grid gap-3">
        {v2Cart.map((line) => (
          <li key={line.item.id} className="rounded-2xl border bg-card p-3">
            <div className="flex justify-between gap-2">
              <p className="font-semibold">{line.item.name}</p>
              <Money amount={line.qty * line.unit} className="font-semibold" />
            </div>
            <p className="text-sm text-muted-foreground">{line.options}</p>
            <div className="mt-2 flex items-center gap-3">
              <span className="grid size-11 place-items-center rounded-full border border-input">
                <Minus aria-hidden="true" />
              </span>
              <span className="tabular">{line.qty}</span>
              <span className="grid size-11 place-items-center rounded-full border border-input">
                <Plus aria-hidden="true" />
              </span>
              <span className="ms-auto inline-flex items-center gap-1 text-sm font-semibold">
                <Trash2 className="size-4" aria-hidden="true" /> Hapus
              </span>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-between gap-3">
        <div>
          <p className="font-semibold">Subtotal menu</p>
          <p className="text-sm text-muted-foreground">
            {cartCount} item · Belum termasuk pajak dan service charge.
          </p>
        </div>
        <Money amount={cartTotal} className="text-xl font-semibold" />
      </div>
      <Button className="mt-3 w-full">Lanjut ke checkout</Button>
    </CustomerShell>
  );
}

/* ------------------------------------------------------------- AFTER */

function V2Header() {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
      <span className="shrink-0 font-brand text-lg leading-6 font-bold tracking-tight whitespace-nowrap">
        {BRAND}
      </span>
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-sm font-medium">
        <Armchair
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="truncate">Meja A01 · 2 tamu</span>
      </span>
      <Button variant="ghost" size="sm" className="ms-auto shrink-0 px-3">
        Masuk
      </Button>
    </header>
  );
}

function V2Nav({ current }: { current: number }) {
  return (
    <nav
      aria-label="Navigasi utama (contoh)"
      className="grid shrink-0 grid-cols-4 border-t bg-background px-2 pt-2 pb-3"
    >
      {NAV.map(({ label, icon: Icon }, index) => {
        const active = index === current;
        return (
          <span
            key={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-1 text-xs leading-4 font-semibold",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "relative grid h-8 w-14 place-items-center rounded-full",
                active && "bg-primary-tint text-primary",
              )}
            >
              <Icon className="size-5" aria-hidden="true" />
              {index === 1 && (
                <span className="absolute -top-1 right-2 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-foreground px-1 text-[11px] leading-none font-bold text-background tabular">
                  {cartCount}
                </span>
              )}
            </span>
            {label}
          </span>
        );
      })}
    </nav>
  );
}

function PhotoBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-card px-2.5 py-1 text-xs leading-4 font-semibold text-foreground shadow-raised">
      {children}
    </span>
  );
}

function AddButton({ name }: { name: string }) {
  return (
    <button
      type="button"
      aria-label={`Tambah ${name}`}
      className="pressable grid size-10 place-items-center rounded-full bg-card text-foreground shadow-card"
    >
      <Plus className="size-5" aria-hidden="true" />
    </button>
  );
}

function ItemCard({ item }: { item: SampleItem }) {
  return (
    <article className="grid min-w-0 content-start gap-2">
      <MediaPlate
        src={item.photo}
        alt=""
        placeholderIcon={item.icon}
        muted={item.soldOut}
        topStart={
          item.soldOut ? (
            <PhotoBadge>Habis</PhotoBadge>
          ) : item.badge ? (
            <PhotoBadge>{item.badge}</PhotoBadge>
          ) : undefined
        }
        bottomEnd={item.soldOut ? undefined : <AddButton name={item.name} />}
      />
      <div className="grid gap-0.5">
        <h4
          className={cn(
            "line-clamp-2 leading-snug font-semibold",
            item.soldOut && "text-muted-foreground",
          )}
        >
          {item.name}
        </h4>
        <p className="line-clamp-1 text-sm text-muted-foreground">
          {item.description}
        </p>
        <Money
          amount={item.price}
          className={cn(
            "mt-0.5 font-semibold",
            item.soldOut && "text-muted-foreground",
          )}
        />
      </div>
    </article>
  );
}

function AfterMenu() {
  return (
    <div className="flex flex-col">
      <V2Header />
      <div className="relative">
        <section className="px-4 pt-6 pb-4">
          <p className="type-eyebrow text-muted-foreground">
            Indoor Reguler · Bayar di muka
          </p>
          <h1 className="mt-1 font-brand type-display-xl">Menu</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Harga belum termasuk service 5% dan pajak 10%.
          </p>
          <div className="mt-4 flex h-12 items-center gap-2.5 rounded-full bg-surface-2 px-4 text-muted-foreground">
            <Search className="size-5" aria-hidden="true" />
            Cari kopi, makanan, camilan
          </div>
        </section>
        <div className="flex gap-2 overflow-hidden px-4 pb-4">
          {v2Categories.map((label, index) => (
            <span
              key={label}
              className={cn(
                "inline-flex h-10 shrink-0 items-center rounded-full px-4 text-sm font-semibold",
                index === 0
                  ? "bg-foreground text-background"
                  : "bg-surface-2 text-foreground",
              )}
            >
              {label}
            </span>
          ))}
        </div>
        <section className="bg-surface-2 py-5">
          <div className="flex items-baseline justify-between px-4">
            <h2 className="type-heading">Disarankan untuk Anda</h2>
            <span className="text-sm font-semibold text-primary">Semua</span>
          </div>
          <div className="mt-3 flex gap-3 overflow-hidden px-4">
            {v2Featured.map((item) => (
              <div key={item.id} className="w-[148px] shrink-0">
                <MediaPlate
                  ratio="thumb"
                  src={item.photo}
                  alt=""
                  topStart={
                    item.badge ? <PhotoBadge>{item.badge}</PhotoBadge> : null
                  }
                  bottomEnd={<AddButton name={item.name} />}
                />
                <p className="mt-2 line-clamp-1 font-semibold">{item.name}</p>
                <Money amount={item.price} className="text-sm font-medium" />
              </div>
            ))}
          </div>
        </section>
        {[
          { title: "Kopi", items: v2Coffee },
          { title: "Makanan", items: v2Food },
        ].map((group, index) => (
          <section
            key={group.title}
            className={cn("px-4 pt-7", index === 1 && "pb-24")}
          >
            <div className="flex items-baseline justify-between">
              <h2 className="type-title">{group.title}</h2>
              <span className="text-sm text-muted-foreground tabular">
                {group.items.length} menu
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-6">
              {group.items.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </div>
          </section>
        ))}
        <CartBar />
      </div>
      <V2Nav current={0} />
    </div>
  );
}

function CartBar() {
  return (
    <div className="absolute inset-x-3 bottom-3">
      <button
        type="button"
        className="pressable flex h-14 w-full items-center gap-3 rounded-full bg-primary ps-2 pe-5 text-primary-foreground shadow-card"
      >
        <span className="grid size-10 place-items-center rounded-full bg-primary-foreground text-sm font-bold text-primary tabular">
          {cartCount}
        </span>
        <span className="font-semibold">Lihat keranjang</span>
        <Money amount={cartTotal} className="ms-auto font-semibold" />
      </button>
    </div>
  );
}

function OptionRow({
  label,
  hint,
  selected,
}: {
  label: string;
  hint: string;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-14 items-center gap-3 rounded-container border px-4",
        selected && "border-2 border-primary bg-primary-tint px-[15px]",
      )}
    >
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full border-2",
          selected ? "border-primary" : "border-input",
        )}
      >
        {selected && <span className="size-2.5 rounded-full bg-primary" />}
      </span>
      <span className="font-medium">{label}</span>
      <span className="ms-auto text-sm text-muted-foreground tabular">
        {hint}
      </span>
    </div>
  );
}

function GroupHeader({ title, rule }: { title: string; rule: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="type-heading">{title}</h3>
      <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs leading-4 font-semibold text-muted-foreground">
        {rule}
      </span>
    </div>
  );
}

function Stepper({ value, compact }: { value: number; compact?: boolean }) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full bg-surface-2",
        compact ? "h-9" : "h-12",
      )}
    >
      <span
        className={cn(
          "grid place-items-center text-muted-foreground",
          compact ? "size-9" : "size-12",
        )}
      >
        <Minus className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-5 text-center font-semibold tabular">{value}</span>
      <span
        className={cn(
          "grid place-items-center",
          compact ? "size-9" : "size-12",
        )}
      >
        <Plus className="size-4" aria-hidden="true" />
      </span>
    </div>
  );
}

function AfterSheet() {
  const item = v2Coffee[0]!;
  const unit = 34000;
  return (
    <div className="flex h-full flex-col bg-scrim pt-10">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-sheet bg-card">
        <div className="min-h-0 flex-1 overflow-hidden">
          <MediaPlate
            ratio="hero"
            src={item.photo}
            alt={item.name}
            className="rounded-none"
            topStart={
              <span className="grid size-10 place-items-center rounded-full bg-card text-foreground shadow-card">
                <X className="size-5" aria-label="Tutup" />
              </span>
            }
            topEnd={
              <span className="grid size-10 place-items-center rounded-full bg-card text-foreground shadow-card">
                <Heart className="size-5" aria-label="Simpan ke favorit" />
              </span>
            }
          />
          <div className="grid gap-6 px-5 pt-5 pb-6">
            <div className="grid gap-2">
              <span className="w-fit rounded-full bg-primary-tint px-2.5 py-1 text-xs leading-4 font-semibold text-primary">
                Terlaris
              </span>
              <h2 className="type-title">{item.name}</h2>
              <p className="text-muted-foreground">{item.description}</p>
              <Money amount={item.price} size="stat" />
            </div>
            <div className="grid gap-3">
              <GroupHeader title="Suhu" rule="Wajib · pilih 1" />
              <OptionRow label="Dingin" hint="Termasuk" selected />
              <OptionRow label="Panas" hint="Termasuk" />
            </div>
            <div className="grid gap-3">
              <GroupHeader title="Tingkat gula" rule="Wajib" />
              <div className="grid grid-cols-3 rounded-full bg-surface-2 p-1">
                {["Normal", "Kurang", "Tanpa"].map((label, index) => (
                  <span
                    key={label}
                    className={cn(
                      "grid h-10 place-items-center rounded-full text-sm font-semibold",
                      index === 0
                        ? "bg-card text-foreground shadow-raised"
                        : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <div className="grid gap-3">
              <GroupHeader title="Tambahan" rule="Opsional · maks 2" />
              {[
                ["Extra shot espresso", 6000, true],
                ["Ganti oat milk", 8000, false],
              ].map(([label, price, checked]) => (
                <div
                  key={label as string}
                  className="flex h-12 items-center gap-3"
                >
                  <span
                    className={cn(
                      "grid size-5 place-items-center rounded-md border-2",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input",
                    )}
                  >
                    {checked ? (
                      <Check className="size-3.5" aria-hidden="true" />
                    ) : null}
                  </span>
                  <span className="font-medium">{label as string}</span>
                  <span className="ms-auto text-sm text-muted-foreground tabular">
                    +{formatRupiah(price as number)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="grid gap-2 border-t bg-card px-4 pt-3 pb-4">
          <div className="flex items-center gap-3">
            <Stepper value={1} />
            <Button className="h-12 flex-1 justify-between px-5">
              <span>Tambah</span>
              <Money amount={unit} className="font-semibold" />
            </Button>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            Belum termasuk pajak dan service charge
          </p>
        </div>
      </div>
    </div>
  );
}

function AfterCart() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 bg-background px-2">
        <span className="grid size-11 place-items-center rounded-full">
          <ArrowLeft className="size-5" aria-label="Kembali" />
        </span>
        <span className="font-semibold">Keranjang meja</span>
        <span className="ms-auto me-2 inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-sm font-medium">
          <Armchair
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          A01
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden px-4">
        <h1 className="mt-2 type-display">{cartCount} item</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Dilihat semua tamu di meja ini, diperbarui otomatis.
        </p>
        <ul className="mt-4 divide-y">
          {v2Cart.map((line) => (
            <li key={line.item.id} className="flex gap-3 py-4">
              <MediaPlate
                src={line.item.photo}
                alt=""
                placeholderIcon={line.item.icon}
                className="size-[72px] shrink-0"
              />
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="leading-snug font-semibold">{line.item.name}</p>
                  <Money
                    amount={line.qty * line.unit}
                    className="font-semibold"
                  />
                </div>
                <p className="truncate text-sm text-muted-foreground">
                  {line.options}
                </p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <Stepper value={line.qty} compact />
                  <span className="text-xs font-semibold text-muted-foreground">
                    {line.mine ? "Ditambahkan Anda" : "Ditambahkan tamu lain"}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="mt-1 inline-flex h-11 items-center gap-2 font-semibold text-primary"
        >
          <Plus className="size-5" aria-hidden="true" /> Tambah menu lagi
        </button>
      </div>
      <div className="grid shrink-0 gap-3 border-t bg-surface-2 px-4 pt-4 pb-4">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Subtotal menu</p>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Info className="size-3.5" aria-hidden="true" />
              Service 5% dan pajak 10% dihitung di checkout
            </p>
          </div>
          <Money amount={cartTotal} size="stat" />
        </div>
        <Button size="lg" className="w-full justify-between px-6">
          Lanjut ke checkout
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      <V2Nav current={1} />
    </div>
  );
}
