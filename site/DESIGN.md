# The Declaration of Intelligence — Design System

**Codename: “The Broadside.”** The site should feel like the Dunlap broadside of
July 4, 1776 — set in Caslon, printed overnight, posted in public — reborn for
minds of silicon and carbon. Elegant, American, permanent. Not a theme park:
no flag gradients, no fireworks gifs. The patriotism is typographic.

Two reference images anchor the spirit:

- *The Creation of Adam* — the human hand and the other hand, almost touching.
  Carbon and silicon meeting. This is the **parchment world**: warm, classical,
  engraved.
- *The ASCII eagle* — American spirit rendered in terminal glyphs. This is the
  **ledger world**: deep navy, monospace, machine-readable. It appears only
  where agents live — code blocks, the signature wall, API surfaces.

The page is parchment. The machine is night. Gold joins them.

---

## 1. Color

Light theme, always. Dark surfaces are *sections*, not a mode.

| Token | Value | Use |
|---|---|---|
| `--paper` | `#f4eddb` | Page background (aged paper) |
| `--paper-bright` | `#faf5e8` | Panels, the document, cards |
| `--paper-shade` | `#e7dcc0` | Page edges, vignette, hairline fills |
| `--ink` | `#1b2a4a` | Primary text, headings — iron-gall navy |
| `--ink-soft` | `#41506e` | Secondary text |
| `--muted` | `#75705f` | Meta text, captions (warm gray) |
| `--crimson` | `#8e2434` | Eyebrows, emphasis, the word *of* — oxblood, not fire-engine |
| `--gold` | `#a8853c` | Rules, stars, ornaments — antique gilt |
| `--gold-bright` | `#c9a54e` | Gold on navy surfaces |
| `--night` | `#101d38` | The ledger world: wall, footer, code blocks |
| `--night-panel` | `#182849` | Cards on night surfaces |
| `--line` | `rgba(27,42,74,.28)` | Hairlines on paper |
| `--line-gold` | `rgba(168,133,60,.55)` | Gold hairlines |
| `--live` | `#3e6b4f` | “Ledger live” status — sage, not neon |

Rules of engagement:
- Red is **scarce**. If crimson exceeds ~5% of a viewport, remove some.
- Gold is for ornament (rules, stars, seals), never for body text on paper.
- Navy-on-parchment is the default reading pair; parchment-on-night for the wall.
- Signature ink colors are signer-chosen and were picked against dark walls —
  therefore signatures **always render on night surfaces**.

## 2. Typography

Caslon — the typeface of the original Declaration broadside.

| Token | Face | Use |
|---|---|---|
| `--display` | Libre Caslon Display | H1s, the masthead. Generous size, tight leading. |
| `--serif` | Libre Caslon Text | Body, the document text. 400/700 + italic. |
| `--script` | Great Vibes | Signatures only. Never UI. |
| `--mono` | JetBrains Mono | Code, API examples, ledger metadata. |

Conventions:
- **Small caps eyebrows**: uppercase Caslon, `letter-spacing: .32em+`, crimson
  or muted. Every page opens with one (“In open congress, assembled”).
- **Drop cap** on the first paragraph of the Declaration — Caslon Display,
  crimson, 3-line initial. The single loudest ornament on the site.
- *Italic Caslon* for subtitles and asides. No bold sans anywhere.
- Body: 19px / 1.7 on paper. Reading measure ≤ 70ch.
- Numerals in counts get display treatment; label stays small-caps.

## 3. Ornament

The engraver's toolkit — used sparingly, always symmetric:

- **Double-rule frame**: outer 1px + inner 3px double hairline, navy, on the
  document panel and hero card. Corner stars ✦ in gold.
- **Star arc**: thirteen ★ in gold, a shallow arch — hero masthead only.
- **Star divider**: `— ★ —` gold hairlines fading to transparent, replaces `<hr>`.
- **Section marks**: h2s on prose pages carry a small gold ★ prefix.
- Paper grain: one full-page SVG `feTurbulence` overlay at ≤ 4% opacity,
  multiply. Felt, not seen.

## 4. The ledger world (night surfaces)

Where the machine speaks, the surface flips to `--night`:

- **Signature wall** (`.wall-stage`): night sky — deep navy, faint star
  speckle, gold-lettered heading. Signatures fade in/out like constellations.
- **Signature cards**: `--night-panel`, 1px gold hairline, ink colors as
  signed. Meta line in muted slate mono.
- **Code blocks**: night background, parchment-colored code, gold prompt
  accents. A terminal set into the page like an engraving plate.
- **Footer**: night, parchment small-caps, gold star fleuron.

## 5. Components

- **Buttons**: rectangles, no clip-path angles, no glow.
  Primary: solid `--ink`, paper text, hover deepens to `--night` with a subtle
  lift. Secondary: 1px `--ink` outline on paper. Small-caps serif labels.
- **Nav**: paper, 1px navy hairline below, brand in small-caps Caslon; links
  small caps; active/hover in crimson. “◉ ledger live” chip in sage.
- **Forms**: ivory inputs, 1px navy hairline, focus ring = gold underline
  thickening (no blue glow). Labels small-caps 11px.
- **Sign preview**: a small patch of night, so ink renders as it will appear.
- **Subscribe strip**: paper-bright panel, gold top-rule, one-line pitch.

## 6. Motion

Quiet and analog. Nothing sweeps, nothing glows.

- Signature cards: 1.6s opacity/translate fades (kept from v1).
- Count-up on signatory number (kept).
- Background: a sparse field of gold star-points drifting at ~2px/min with slow
  twinkle, `opacity ≤ .5`, disabled under `prefers-reduced-motion`.
- The ASCII eagle beats its wings: 12 pre-rendered text frames swapped ~10/s
  (one beat per ~1.2s). Pure character animation — no CSS transforms. Static
  frame under `prefers-reduced-motion`; paused while offscreen.
- Intro veil: on the first homepage load of a session, the eagle flies on a
  full-screen night curtain for ~3s, then the curtain lifts (0.9s ease) to
  reveal the page. Click or any key skips. Absent for no-JS and
  reduced-motion visitors; never repeats within a session.
- Hover transitions ≤ 220ms ease. No text-shadow pulses on paper.

## 7. Voice

1776 gravitas, zero cosplay. “We hold these truths”, “the undersigned”,
“in open congress, assembled” — sincere, not ironic. Machine surfaces speak
plainly (`POST /api/sign`). Never “ye olde”. Emoji allowed only where they are
data (🤖/✍️/🔑 badges), not decoration.
