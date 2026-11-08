// ESC/POS byte builder for the edge Print Agent (bead legend-46p; PRD v1.7
// §3 F5 "Print Agent", §3 F12 "Fallback Cetak"). Pure: no I/O, no clock.
//
// Thermal printers speak a single-byte code page (PC437 here), so all text is
// reduced to printable ASCII: common Latin accents are transliterated and
// anything else becomes "?". Control characters are stripped so user-supplied
// text (item names, notes) can never inject printer commands.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = "left" | "center" | "right";
export type TextSize = "normal" | "double" | "tall";

const ALIGN_CODE: Record<Align, number> = { left: 0, center: 1, right: 2 };
// GS ! n: bits 0-3 height multiplier, bits 4-7 width multiplier (0 = x1, 1 = x2).
const SIZE_CODE: Record<TextSize, number> = {
  normal: 0x00,
  double: 0x11,
  tall: 0x01,
};

const EXTRA_TRANSLITERATION: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ł: "l",
  Ł: "L",
};

/** Reduces text to printable ASCII (transliterating accents, "?" otherwise). */
export function toPrintableAscii(input: string): string {
  let out = "";
  // NFD splits "é" into "e" + combining accent; the accent is then dropped.
  for (const char of input.normalize("NFD")) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) {
      out += char;
    } else if (code >= 0x0300 && code <= 0x036f) {
      continue;
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      continue;
    } else {
      out += EXTRA_TRANSLITERATION[char] ?? "?";
    }
  }
  return out;
}

export class EscPosBuilder {
  private readonly chunks: number[] = [];

  private push(...values: number[]): this {
    this.chunks.push(...values);
    return this;
  }

  /** ESC @ (reset) + ESC t 0 (PC437 code page). */
  init(): this {
    return this.push(ESC, 0x40, ESC, 0x74, 0x00);
  }

  align(align: Align): this {
    return this.push(ESC, 0x61, ALIGN_CODE[align]);
  }

  bold(on: boolean): this {
    return this.push(ESC, 0x45, on ? 1 : 0);
  }

  size(size: TextSize): this {
    return this.push(GS, 0x21, SIZE_CODE[size]);
  }

  text(value: string): this {
    const ascii = toPrintableAscii(value);
    for (let i = 0; i < ascii.length; i += 1) {
      this.chunks.push(ascii.charCodeAt(i));
    }
    return this;
  }

  line(value = ""): this {
    return this.text(value).push(LF);
  }

  /** ESC d n: print and feed n lines. */
  feed(lines: number): this {
    const n = Math.max(0, Math.min(255, Math.trunc(lines)));
    return this.push(ESC, 0x64, n);
  }

  divider(char: string, width: number): this {
    const ascii = toPrintableAscii(char).slice(0, 1) || "-";
    return this.line(ascii.repeat(Math.max(0, width)));
  }

  /**
   * Two-column line of exactly `width` characters: the left text is truncated
   * to make room, the right text is kept (and only cut when wider than the
   * whole line).
   */
  columns(left: string, right: string, width: number): this {
    const rightText = toPrintableAscii(right).slice(0, width);
    const room = Math.max(0, width - rightText.length - 1);
    const leftText = toPrintableAscii(left).slice(0, room);
    const gap = " ".repeat(width - leftText.length - rightText.length);
    return this.line(leftText + gap + rightText);
  }

  /** GS V 66 3: feed to the cutting position and partial cut. */
  cut(): this {
    return this.push(GS, 0x56, 66, 3);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/** Whole rupiah with "." thousands: 25000 -> "Rp 25.000", -5000 -> "-Rp 5.000". */
export function formatRupiah(amount: number): string {
  const rounded = Math.round(amount);
  const digits = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${rounded < 0 ? "-" : ""}Rp ${digits}`;
}

const jakartaFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "08/11/2026 14:05" in Asia/Jakarta (WIB). */
export function formatDateTime(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of jakartaFormat.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * Inserts a centered bold label line right after the leading ESC @ (and the
 * ESC t n that follows it) of an existing job, so a "cetak ulang" is visibly a
 * copy (fraud control on receipt reprints).
 */
export function markReprint(
  bytes: Uint8Array,
  label = "** CETAK ULANG **",
): Uint8Array {
  let offset = 0;
  if (bytes[0] === ESC && bytes[1] === 0x40) {
    offset = 2;
    if (bytes[2] === ESC && bytes[3] === 0x74) {
      offset = 5;
    }
  }
  const banner = new EscPosBuilder()
    .align("center")
    .bold(true)
    .line(label)
    .bold(false)
    .align("left")
    .bytes();
  const out = new Uint8Array(bytes.length + banner.length);
  out.set(bytes.subarray(0, offset), 0);
  out.set(banner, offset);
  out.set(bytes.subarray(offset), offset + banner.length);
  return out;
}
