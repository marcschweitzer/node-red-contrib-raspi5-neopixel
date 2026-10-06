# node-red-contrib-raspi5-neopixel

WS2812 / NeoPixel LED strip Node for **Raspberry Pi 5** – **pure JavaScript**, no Python, no external daemon.

Supports:
- SPI0 **and** SPI1 (bus/device selectable)
- **Selectable color order** (GRB, RGB, BRG, BGR, RBG, GBR) – red is red on every strip model
- `test` command to find the right color order in seconds
- Global **brightness** (0–100 %) + optional **gamma** correction
- Fill, single pixel, range or one color per LED
- Colors as CSS name, hex, `r,g,b`, array or object
- Effects: `rainbow`, `colorcycle`, `lava`, `blink`, `pulse`, `sparkle`, `chase`
- Dynamic wiring hints in the Node-RED editor

---

## ⚠️ Prerequisite: SPI must be enabled

This node talks **directly** to `/dev/spidev*`.  
If SPI is not enabled, the node **cannot work**.

### Enable SPI0 (standard)

```bash
sudo raspi-config
```
→ *Interface Options* → *SPI* → **Enable**

Reboot, then check:
```bash
ls -l /dev/spidev*
```
You should see at least:
```
/dev/spidev0.0
```

---

### Enable SPI1 (second SPI controller)

SPI1 is **not enabled by default**.

Edit:
```bash
sudo nano /boot/firmware/config.txt
```

Add **one** of the following lines:
```
dtoverlay=spi1-1cs
```
or (3 chip-selects):
```
dtoverlay=spi1-3cs
```

Reboot.

Verify:
```bash
ls -l /dev/spidev*
```
Expected:
```
/dev/spidev1.0
```

If `/dev/spidev1.0` does not exist → SPI1 is **not active**.

---

### More than ~170 LEDs

The kernel limits one SPI transfer to 4096 bytes by default (≈ 170 LEDs).  
The node shows an error with the exact numbers if your strip is too long.

Fix: add this to the **end of the single line** in `/boot/firmware/cmdline.txt`:
```
spidev.bufsiz=65536
```
Reboot and check:
```bash
cat /sys/module/spidev/parameters/bufsiz
```
65536 bytes ≈ 2700 LEDs.

---

## Wiring

The node editor shows **dynamic wiring instructions** depending on SPI0/SPI1 selection.

Only the **MOSI** pin is used as data line:

| Bus | MOSI (→ LED DIN) |
|---|---|
| SPI0 | GPIO10 (Pin 19) |
| SPI1 | GPIO20 (Pin 38) |

- GND Pi ↔ GND LED ↔ GND power supply (⚠️ **common ground** is mandatory)
- 5V LED from an **external power supply** (⚠️ never more than a few LEDs from the Pi 5V pin)
- ~60 mA per LED at full white
- Recommended: 330 Ω in series with DIN, 1000 µF across 5V/GND at the strip
- WS2812 expects 5V logic: short data wire (< 30 cm) or a 74AHCT125 / 74HCT245 level shifter

---

## Installation

### Via Node-RED Palette
Search for:
```
node-red-contrib-raspi5-neopixel
```

### Manual install
```bash
cd ~/.node-red
npm install node-red-contrib-raspi5-neopixel
sudo systemctl restart nodered
```

---

## Node Configuration

Configured **entirely inside the node**:

- SPI Bus (0 or 1)
- Device / CS (0–2)
- SPI speed (Hz, default `6400000`)
- Number of LEDs
- Color order: `GRB` (most WS2812/WS2812B), `RGB`, `BRG`, `BGR`, `RBG`, `GBR`
- Brightness (%)
- Gamma correction
- Off on close (LEDs off on deploy / stop)

---

## Finding the right color order

Send:
```
msg.payload = "test"
```
- LED 0 must be **red**, LED 1 **green**, LED 2 **blue**
- Red and green swapped → switch between `GRB` and `RGB`
- Blue in the wrong place → try the other orders

---

## Input

### Fill the whole strip
```
msg.payload = "red"            // CSS color name (148 names)
msg.payload = "#FF8000"        // hex, also "#F80" or "FF8000"
msg.payload = "255,128,0"      // also "rgb(255,128,0)"
msg.payload = [255, 128, 0]
msg.payload = { r: 255, g: 128, b: 0 }
```

### Single pixel / range
```
msg.payload = "blue"
msg.pixel   = 4                // only LED 4

msg.payload = "green"
msg.start   = 10
msg.count   = 5                // LEDs 10..14
```
Other LEDs keep their color.

### One color per LED
```
msg.payload = ["red", [0,255,0], "#0000FF", "off"]
```
LEDs not in the array are switched off.

### Off
```
msg.payload = "off"            // also "clear" or "black"
```

### Brightness
```
msg.brightness = 30            // 0..100 %, stays active
```
Can be sent alone (no payload) or together with a color.

### Effects
```
msg.payload  = "pulse"
msg.color    = "orange"        // optional (blink, pulse, sparkle, chase)
msg.interval = 30              // optional, ms per frame
```

| Effect | Description |
|---|---|
| `rainbow` | moving rainbow over the strip |
| `colorcycle` | whole strip cycles 7 colors |
| `lava` | red/orange flicker |
| `blink` | on/off (`msg.color`) |
| `pulse` | smooth fade in/out (`msg.color`) |
| `sparkle` | random twinkles (`msg.color`) |
| `chase` | one LED running along the strip (`msg.color`) |

An effect runs until the next message.

---

## Output

No output. The node status shows the current state:
- green dot: ready / color
- blue dot: effect running
- yellow dot: test pattern
- grey ring: off
- red ring: error

---

## Examples

*Menu → Import → Examples → node-red-contrib-raspi5-neopixel → basic*

---

## Safety

- ❌ Never power long strips from the Pi 5V rail
- ❌ Never hot-plug a strip while powered
- ✅ Test with low brightness first

---

## Test / Debug

Check permissions:
```bash
groups
# user must be in group: spi
```

Add user if needed:
```bash
sudo usermod -aG spi $USER
```

Re-login required.

Wrong / flickering colors:
- wrong color order → use `test`
- missing common GND or weak power supply
- long data wire without level shifter

---

## Credits

Based on [@tomsith/node-red-contrib-ws2812-pi5](https://www.npmjs.com/package/@tomsith/node-red-contrib-ws2812-pi5) by Tom Schmitz (MIT).

---

## License
MIT
