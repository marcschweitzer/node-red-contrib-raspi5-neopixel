/**
 * node-red-contrib-raspi5-neopixel
 * Node: raspi5-neopixel
 *
 * WS2812 / NeoPixel LED strip on Raspberry Pi 5 via SPI (pure JS, spi-device).
 *
 * Config:
 * - SPI bus (0..5) + device / CS, SPI speed
 * - Number of LEDs, color order (RGB / GRB / ...), brightness %, gamma, off on close
 *
 * Input (msg.payload):
 * - "red", "#FF0000", "#F00", "FF0000", "255,0,0", "rgb(255,0,0)", [255,0,0], {r,g,b}
 *     -> fill strip (or msg.pixel / msg.start + msg.count only)
 * - [[255,0,0], "blue", "#00FF00", ...]   -> one color per LED (rest off)
 * - "off" | "clear" | "black"              -> all LEDs off
 * - "test"                                 -> LED0 red, LED1 green, LED2 blue (check color order)
 * - "rainbow" | "colorcycle" | "lava" | "blink" | "pulse" | "sparkle" | "chase" -> effect
 *
 * Overrides via msg:
 * - msg.brightness (0..100 %), msg.color (effect color), msg.interval (effect ms)
 * - msg.pixel (index), msg.start + msg.count (range)
 */
module.exports = function(RED) {
  const { WS2812, parseColor, hsvToRgb } = require("../lib/ws2812");

  const EFFECTS = ["rainbow", "colorcycle", "lava", "blink", "pulse", "sparkle", "chase"];
  const EFFECT_DEFAULT_MS = {
    rainbow: 40, colorcycle: 200, lava: 150, blink: 500, pulse: 30, sparkle: 150, chase: 80
  };
  const CYCLE_COLORS = [
    [255, 0, 0], [255, 127, 0], [255, 255, 0], [0, 255, 0], [0, 0, 255], [75, 0, 130], [148, 0, 211]
  ];

  function parseIntSafe(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  }

  function percentTo255(p) {
    return Math.round(Math.max(0, Math.min(100, parseIntSafe(p, 100))) * 2.55);
  }

  function NeopixelNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Config
    const bus = parseIntSafe(config.bus, 0);
    const dev = parseIntSafe(config.dev, 0);
    const speedHz = Math.max(1000000, parseIntSafe(config.speedHz, 6400000));
    const numLeds = Math.max(1, parseIntSafe(config.numLeds, 10));
    const colorOrder = String(config.colorOrder || "GRB").toUpperCase();
    const brightnessPct = Math.max(0, Math.min(100, parseIntSafe(config.brightness, 100)));
    const gamma = !!config.gamma;
    const offOnClose = (config.offOnClose === undefined) ? true : !!config.offOnClose;

    let strip = null;
    let effectTimer = null;

    function setStatus(fill, shape, text) {
      node.status({ fill, shape, text });
    }

    function ensureStrip() {
      if (strip) return;
      strip = new WS2812({
        bus, device: dev, numLeds, colorOrder, speedHz,
        brightness: percentTo255(brightnessPct), gamma
      });
      strip.open();
      setStatus("green", "dot", `ready spidev${bus}.${dev} (${numLeds}, ${colorOrder})`);
    }

    function stopEffect() {
      if (effectTimer) clearInterval(effectTimer);
      effectTimer = null;
    }

    function colorText(c) {
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }

    // ---------- Effects ----------
    function startEffect(name, msg) {
      const interval = Math.max(10, parseIntSafe(msg.interval, EFFECT_DEFAULT_MS[name]));
      const color = parseColor(msg.color) || [255, 255, 255];
      let step = 0;
      let frame;

      switch (name) {
        case "rainbow":
          frame = () => {
            for (let i = 0; i < numLeds; i++) {
              strip.setPixel(i, ...hsvToRgb((i * 360 / numLeds) + step * 4, 1, 1));
            }
          };
          break;
        case "colorcycle":
          frame = () => strip.fill(...CYCLE_COLORS[step % CYCLE_COLORS.length]);
          break;
        case "lava":
          frame = () => {
            for (let i = 0; i < numLeds; i++) {
              strip.setPixel(i, 200 + Math.floor(Math.random() * 55), Math.floor(Math.random() * 50), 0);
            }
          };
          break;
        case "blink":
          frame = () => (step % 2 === 0) ? strip.fill(...color) : strip.fill(0, 0, 0);
          break;
        case "pulse":
          frame = () => {
            const k = (1 - Math.cos((step % 100) / 100 * 2 * Math.PI)) / 2; // 0..1..0
            strip.fill(color[0] * k, color[1] * k, color[2] * k);
          };
          break;
        case "sparkle":
          frame = () => {
            strip.clearBuffer();
            for (let i = 0; i < numLeds; i++) if (Math.random() > 0.8) strip.setPixel(i, ...color);
          };
          break;
        case "chase":
          frame = () => {
            strip.clearBuffer();
            strip.setPixel(step % numLeds, ...color);
          };
          break;
        default:
          return false;
      }

      const tick = () => {
        try {
          frame();
          strip.show();
          step++;
        } catch (e) {
          stopEffect();
          setStatus("red", "ring", e.message || "effect error");
          node.error(e, {});
        }
      };
      tick();
      effectTimer = setInterval(tick, interval);
      setStatus("blue", "dot", `${name} ${interval}ms`);
      return true;
    }

    // ---------- Static colors ----------
    function applyColor(c, msg) {
      if (msg.pixel !== undefined) {
        strip.setPixel(parseIntSafe(msg.pixel, -1), ...c);
        setStatus("green", "dot", `#${msg.pixel} ${colorText(c)}`);
      } else if (msg.start !== undefined || msg.count !== undefined) {
        const start = parseIntSafe(msg.start, 0);
        const count = parseIntSafe(msg.count, numLeds - start);
        strip.fill(...c, start, count);
        setStatus("green", "dot", `${start}+${count} ${colorText(c)}`);
      } else {
        strip.fill(...c);
        setStatus("green", "dot", colorText(c));
      }
      strip.show();
    }

    function applyArray(arr) {
      strip.clearBuffer();
      const n = Math.min(numLeds, arr.length);
      for (let i = 0; i < n; i++) {
        const c = parseColor(arr[i]);
        if (c) strip.setPixel(i, ...c);
      }
      strip.show();
      setStatus("green", "dot", `array (${arr.length})`);
    }

    function isColorArray(p) {
      // [r,g,b] numbers = one color; anything else = list of colors
      return Array.isArray(p) && !(p.length === 3 && p.every(v => typeof v === "number"));
    }

    // Input
    node.on("input", function(msg, send, done) {
      try {
        ensureStrip();

        if (msg.brightness !== undefined) {
          strip.setBrightness(percentTo255(msg.brightness));
        }

        const p = msg.payload;

        // Brightness-only message: re-send current buffer
        if ((p === undefined || p === null || p === "") && msg.brightness !== undefined) {
          if (!effectTimer) strip.show();
          setStatus("green", "dot", `brightness ${msg.brightness}%`);
          done();
          return;
        }

        stopEffect();

        if (typeof p === "string") {
          const s = p.trim().toLowerCase();
          if (s === "off" || s === "clear" || s === "black") {
            strip.off();
            setStatus("grey", "ring", "off");
            done();
            return;
          }
          if (s === "test") {
            strip.clearBuffer();
            strip.setPixel(0, 255, 0, 0);
            strip.setPixel(1, 0, 255, 0);
            strip.setPixel(2, 0, 0, 255);
            strip.show();
            setStatus("yellow", "dot", `test R-G-B (${strip.colorOrder})`);
            done();
            return;
          }
          if (EFFECTS.includes(s)) {
            startEffect(s, msg);
            done();
            return;
          }
        }

        if (isColorArray(p)) {
          applyArray(p);
          done();
          return;
        }

        const c = parseColor(p);
        if (!c) {
          setStatus("red", "ring", "invalid payload");
          done(new Error(`Invalid payload: ${JSON.stringify(p)}`));
          return;
        }
        applyColor(c, msg);
        done();
      } catch (e) {
        setStatus("red", "ring", e.message || "error");
        done(e);
      }
    });

    node.on("close", function(removed, done) {
      stopEffect();
      try {
        if (strip && offOnClose) strip.off();
      } catch (e) { /* ignore */ }
      try {
        if (strip) strip.close();
      } catch (e) { /* ignore */ }
      strip = null;
      node.status({});
      done();
    });

    // Start
    (async () => {
      try {
        ensureStrip();
      } catch (e) {
        setStatus("red", "ring", e.message || "init error");
        node.error(e, {});
      }
    })();
  }

  RED.nodes.registerType("raspi5-neopixel", NeopixelNode);
};
