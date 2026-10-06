// lib/ws2812.js
// Pure JS WS2812 / NeoPixel driver for Raspberry Pi 5 via spi-device (any SPI bus / CS).
// Includes: SPI bit encoding (1 WS2812 bit = 8 SPI bits), selectable color order,
// brightness, optional gamma correction, latch/reset padding, spidev bufsiz check.
//
// Based on the encoding idea of @tomsith/node-red-contrib-ws2812-pi5 (MIT, Tom Schmitz).

const fs = require("fs");
const spi = require("spi-device");
const COLORS = require("./colors");

// ---------- WS2812 timing (SPI encoding) ----------
// At ~6.4 MHz one SPI bit is ~156 ns, 8 SPI bits = one WS2812 bit (~1.25 us)
const BIT_0          = 0xC0;   // 0b11000000 -> ~0.31 us high
const BIT_1          = 0xF8;   // 0b11111000 -> ~0.78 us high
const SPI_BYTES_PER_COLOR_BYTE = 8;
const CHANNELS       = 3;
const BYTES_PER_LED  = CHANNELS * SPI_BYTES_PER_COLOR_BYTE;   // 24

// ---------- Padding ----------
const LEAD_BYTES     = 4;      // low level before data (clean start)
const LATCH_BYTES    = 320;    // ~400 us low at 6.4 MHz (> 280 us reset for WS2812B v5)

// ---------- Defaults ----------
const DEFAULT_SPEED_HZ = 6400000;
const VALID_ORDERS   = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"];
const SPIDEV_BUFSIZ_PATH = "/sys/module/spidev/parameters/bufsiz";

// Precomputed lookup: color byte -> 8 SPI bytes
const LUT = (() => {
  const t = new Array(256);
  for (let v = 0; v < 256; v++) {
    const b = Buffer.alloc(8);
    for (let i = 0; i < 8; i++) b[i] = (v & (0x80 >> i)) ? BIT_1 : BIT_0;
    t[v] = b;
  }
  return t;
})();

// Gamma 2.2 table (perceptually more linear fades)
const GAMMA = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = Math.round(Math.pow(i / 255, 2.2) * 255);
  return t;
})();

function clamp255(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, n));
}

/**
 * Parse any supported color into [r, g, b]. Returns null if not a color.
 * Accepts: "red", "#F00", "#FF0000", "FF0000", "rgb(255,0,0)", "255,0,0",
 *          [255,0,0], {r,g,b}
 */
function parseColor(c) {
  if (c == null) return null;
  if (Array.isArray(c)) {
    if (c.length < 3) return null;
    return [clamp255(c[0]), clamp255(c[1]), clamp255(c[2])];
  }
  if (typeof c === "object") {
    if (c.r === undefined && c.g === undefined && c.b === undefined) return null;
    return [clamp255(c.r || 0), clamp255(c.g || 0), clamp255(c.b || 0)];
  }
  if (typeof c !== "string") return null;

  const s = c.trim().toLowerCase();
  if (COLORS[s]) return COLORS[s].slice();

  let m = s.match(/^#?([0-9a-f]{6})$/);
  if (m) {
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  m = s.match(/^(?:rgb\()?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)?$/);
  if (m) return [clamp255(m[1]), clamp255(m[2]), clamp255(m[3])];
  return null;
}

/** HSV (h 0..360, s/v 0..1) -> [r, g, b] */
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  return [clamp255((r + m) * 255), clamp255((g + m) * 255), clamp255((b + m) * 255)];
}

/** Read the kernel spidev max transfer size (bytes), or null if unknown. */
function readSpidevBufsiz() {
  try {
    const n = parseInt(fs.readFileSync(SPIDEV_BUFSIZ_PATH, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

class WS2812 {
  /**
   * @param {object} opts
   * @param {number} opts.bus        SPI bus (0 = SPI0, 1 = SPI1, ...)
   * @param {number} opts.device     chip select (only needed to open /dev/spidevB.D)
   * @param {number} opts.numLeds
   * @param {string} opts.colorOrder RGB | GRB | ...
   * @param {number} opts.speedHz
   * @param {number} opts.brightness 0..255
   * @param {boolean} opts.gamma
   */
  constructor(opts = {}) {
    this.bus = opts.bus ?? 0;
    this.device = opts.device ?? 0;
    this.numLeds = Math.max(1, opts.numLeds | 0 || 1);
    this.speedHz = opts.speedHz || DEFAULT_SPEED_HZ;
    this.setColorOrder(opts.colorOrder || "GRB");
    this.brightness = opts.brightness ?? 255;
    this.gamma = !!opts.gamma;

    // Logical pixel colors (RGB, before brightness / order)
    this.pixels = new Uint8Array(this.numLeds * CHANNELS);
    this.txLength = LEAD_BYTES + this.numLeds * BYTES_PER_LED + LATCH_BYTES;
    this.tx = Buffer.alloc(this.txLength, 0x00);
    this.spi = null;
  }

  static get VALID_ORDERS() { return VALID_ORDERS.slice(); }
  static get BYTES_PER_LED() { return BYTES_PER_LED; }

  /** Max LEDs the current kernel spidev bufsiz allows in one transfer (null = unknown). */
  static maxLedsForBufsiz(bufsiz) {
    if (!bufsiz) return null;
    return Math.floor((bufsiz - LEAD_BYTES - LATCH_BYTES) / BYTES_PER_LED);
  }

  open() {
    if (this.spi) return;
    const bufsiz = readSpidevBufsiz();
    if (bufsiz && this.txLength > bufsiz) {
      throw new Error(
        `${this.numLeds} LEDs need ${this.txLength} bytes per SPI transfer, ` +
        `but spidev.bufsiz is ${bufsiz} (max ~${WS2812.maxLedsForBufsiz(bufsiz)} LEDs). ` +
        `Add "spidev.bufsiz=65536" to /boot/firmware/cmdline.txt and reboot.`
      );
    }
    this.spi = spi.openSync(this.bus, this.device, { mode: spi.MODE0, maxSpeedHz: this.speedHz });
  }

  close() {
    if (this.spi) {
      try { this.spi.closeSync(); } catch (e) { /* ignore */ }
      this.spi = null;
    }
  }

  setColorOrder(order) {
    const o = String(order || "GRB").toUpperCase();
    if (!VALID_ORDERS.includes(o)) throw new Error(`invalid color order "${order}"`);
    this.colorOrder = o;
    // index into [r, g, b] for each wire position
    this._orderIdx = o.split("").map(ch => ({ R: 0, G: 1, B: 2 })[ch]);
  }

  setBrightness(b) { this.brightness = clamp255(b); }
  setGamma(on) { this.gamma = !!on; }

  setPixel(i, r, g, b) {
    if (i < 0 || i >= this.numLeds) return;
    const o = i * CHANNELS;
    this.pixels[o] = clamp255(r);
    this.pixels[o + 1] = clamp255(g);
    this.pixels[o + 2] = clamp255(b);
  }

  getPixel(i) {
    const o = i * CHANNELS;
    return [this.pixels[o], this.pixels[o + 1], this.pixels[o + 2]];
  }

  fill(r, g, b, start = 0, count = this.numLeds) {
    const end = Math.min(this.numLeds, start + count);
    for (let i = Math.max(0, start); i < end; i++) this.setPixel(i, r, g, b);
  }

  clearBuffer() { this.pixels.fill(0); }

  /** Encode pixels into the SPI buffer (brightness, gamma, color order). */
  encode() {
    const bri = this.brightness;
    const idx = this._orderIdx;
    const rgb = [0, 0, 0];
    let pos = LEAD_BYTES;
    for (let i = 0; i < this.numLeds; i++) {
      const o = i * CHANNELS;
      for (let c = 0; c < 3; c++) {
        let v = (this.pixels[o + c] * bri + 127) / 255 | 0;
        if (this.gamma) v = GAMMA[v];
        rgb[c] = v;
      }
      for (let w = 0; w < 3; w++) {
        LUT[rgb[idx[w]]].copy(this.tx, pos);
        pos += SPI_BYTES_PER_COLOR_BYTE;
      }
    }
    return this.tx;
  }

  show() {
    if (!this.spi) this.open();
    const buf = this.encode();
    this.spi.transferSync([{ sendBuffer: buf, byteLength: buf.length, speedHz: this.speedHz }]);
  }

  /** All LEDs off and send. */
  off() {
    this.clearBuffer();
    if (this.spi) this.show();
  }
}

module.exports = { WS2812, parseColor, hsvToRgb, clamp255, readSpidevBufsiz, COLORS };
