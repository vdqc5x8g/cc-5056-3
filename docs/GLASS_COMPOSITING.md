# Glass Compositing Lab — documentation

A tool for estimating the optical components of a **fixed transparent product**
from photographs over **several known backgrounds**, then compositing it onto a
**new** background. It separates

- **transmission `T`** — per-channel chromatic attenuation (what the glass lets
  through, colour-tinted),
- **additive reflection `A`** — a background-independent specular/reflection
  term added on top,

and optionally a **background coordinate offset `d`** — a coarse per-tile
translation standing in for refraction.

The declared model is

```
O_k(x) = T(x) · B_k(x + s_k + d(x)) + A(x)
```

where `O_k` is observation `k` (the glass over known plate `B_k`), `s_k` is that
observation's registration shift, and `x` indexes pixels.

> **Scope.** This model cannot express all glass behaviour. It has no refraction
> curvature, caustics, dispersion or polarisation, and it assumes one fixed
> object with additive, background-independent reflection. A single
> transparency/alpha value cannot reproduce arbitrary glass optics. The tool
> reports what it cannot explain instead of hiding it.

---

## 1. Graphical entry point (primary)

The main way to use the tool is the browser interface.

```bash
npm install
npm run ui           # serves app/index.html on http://localhost:5173/
```

Open <http://localhost:5173/>. The layout has three columns:

1. **Observations & selection** — pick a sample scene (or load your own shots in
   the same place you would extend it), then **paint the transmission region**
   (the clear body of the product). Buttons: *Paint* / *Erase* / *Clear* /
   *Fill body*. Each shot is a tab; the object must be the same in every shot.

   Above the estimate the interface runs **consistency checks**:
   - per-shot registration (NCC against its own plate),
   - per-shot exposure gain,
   - gain/shift spread across shots,
   - "one fixed object explains all shots" (per-observation residual ratio).

   Any of these failing raises a warning *before* any T/A number is trusted.

2. **Estimated components** — four panels:
   - **Transmission `T`** (chromatic attenuation; 1.0 reads as neutral grey),
   - **Additive reflection `A`**,
   - **Background term `T·B_new`** (the transmitted background contribution),
   - **Reconstruction residual** (model vs. each observation).

   **Magenta means UNDETERMINED** — the model cannot separate transmission from
   reflection there. It is *not* drawn as transparent. The identifiability meter
   and table quantify how much of the selection was resolved.

3. **Composite onto a new background** — choose a new background and (optionally)
   whether the model includes a background coordinate offset. The result is
   **recomputed** as `T·B_new + A`; the original photograph is never pasted
   through. Next to it, for the built-in sample scenes, is a **ground-truth
   reference** rendered from the true fields on the same new background, plus a
   **prediction-vs-reference** comparison restricted to resolved pixels.

### Sample scenes (with ground truth)

| scene | what it demonstrates |
|---|---|
| `basic` | Two distinct backgrounds; T and A separable almost everywhere. |
| `threeway` | Three backgrounds; redundancy lets the residual check catch a bad frame. |
| `degenerate` | Two identical backgrounds; the tool refuses to guess (0% identifiable). |
| `refraction` | Radial background offset; the tile-translation proxy only partly fits it, and identifiability drops honestly. |
| `drifting` | The object moved in one shot; consistency checks flag it. |

Every scene ships a matching **background plate per shot**, a **held-out new
background**, and a **reference composite computed from the true fields** (never
cropped from an observation or plate).

---

## 2. Command line (auxiliary)

The CLI mirrors the same estimation and export pipeline for batch use. It is a
helper, not the primary interface.

```bash
# Export the synthetic scenes (images, mask, plates, new background, reference, truth)
npm run synth
# or a single scene
node tools/glass-cli.js synth --scene threeway --out out/synth

# Estimate from your own images: one observation and one plate per background.
# --obs and --bg are comma-separated and must be the same length and size.
node tools/glass-cli.js estimate \
  --obs out/synth/basic/obs_1.png,out/synth/basic/obs_2.png \
  --bg  out/synth/basic/bg_1.png,out/synth/basic/bg_2.png \
  --mask out/synth/basic/mask.png \
  --newbg out/synth/basic/new_background.png \
  --out out/estimate
# add --offset to include the per-tile background coordinate offset.

# Checks only (non-zero exit status on a hard inconsistency)
node tools/glass-cli.js check --obs ... --bg ... --mask ...

# Score a prediction against a reference (uses resolved_mask.png when present)
node tools/glass-cli.js compare --pred out/estimate/composite.png \
  --ref out/synth/basic/reference.png
```

`estimate` writes `composite.png`, `transmission.png`, `reflection.png`,
`background_term.png`, per-shot `recon_k.png`, `resolved_mask.png` (white where
T/A were resolved), and `report.json`. Per the model notes, `composite.png` is
recomputed from the estimate; it is not a crop.

---

## 3. How the estimation works

For a fixed offset, the model is **linear in `(T_c, A_c)` per channel**:

```
O_k = T_c · B_k + A_c
```

With `K ≥ 2` observations over **different** backgrounds the 2×2 normal
equations are solvable. The solver (`src/core/solver.js`) does an **exact
box-constrained** least-squares fit (`T ∈ [0,1]`, `A ≥ 0`) by evaluating the
interior optimum and the feasible edges.

**Identifiability gate.** When the backgrounds are locally identical, the system
is rank deficient. Such pixels are marked **UNDETERMINED**; their `T`/`A` are
left as `NaN`, which the interface renders as magenta and the CLI mask marks
black. In addition, a channel is rejected when the estimated transmittance
uncertainty exceeds a stated bound (`maxTstd`, default 0.3). The uncertainty uses
a shared noise floor of one 8-bit step, so it is well defined even on synthetic
noise-free data. This is why the `basic` scene shows ~87% rather than 100%
identifiable: a checkerboard and a gradient genuinely coincide in some places,
and those places are reported as unknown rather than guessed.

**Per-observation checks** (`src/core/align.js`) run before solving:
- registration shift via masked NCC on a background-only ring,
- exposure gain via median plate/observation ratio on that ring, compared at the
  registered position,
- after solving, a per-observation residual ratio: one fixed object must explain
  every shot.

Exposure is normalised per pair (observation scaled into its own plate's
exposure), so cross-background differences cannot be blamed on exposure and
cannot be read as object colour.

**Background coordinate offset** (optional, `includeOffset`) is estimated per
tile by pooling pixels and scoring candidate shifts under the model. A tile
shift is accepted only if it clearly reduces the pooled residual; otherwise the
tile stays at zero. This keeps the option from inventing refraction on scenes
that have none. It is a **translation only** — it does not model refraction
curvature or caustics, and enabling it does not make the model able to recover
arbitrary glass.

---

## 4. What the tool will not do

- It will **not paste the original product** (or its background) through. The
  composite is always recomputed from `T`, `A` and the new background.
- It will **not treat a low residual as proof** that the real material
  parameters are uniquely known. The model is declared; a good fit means the
  declared model explains the observed backgrounds, not that the optics are
  fully recovered. The warnings state the unsupported range explicitly.
- It will **not pretend degenerate regions are transparent.** Locally
  rank-deficient pixels are undetermined (magenta / masked out), not alpha 0.

## 5. Project layout

```
app/                 browser UI (primary entry): index.html, main.js, style.css
src/core/            shared math used by both UI and CLI
  color.js           sRGB <-> linear light
  image.js           linear RGB image container, bilinear sampling
  solver.js          per-pixel box-constrained solve + status codes
  align.js           registration, exposure, offset search
  pipeline.js        end-to-end estimate orchestration
  composite.js       recomposite, components, residual stats, reference
  synth.js / scenes.js  synthetic ground-truth scenes
tools/serve.js       static + JSON server for the UI
tools/glass-cli.js   command-line helper
test/                node:test suites
docs/GLASS_COMPOSITING.md  this document
```

Run the tests with `npm test`. They cover exact recovery on distinct
backgrounds, refusal on identical backgrounds, composite fidelity against a
held-out reference, exposure-drift and moving-object detection, and that the
offset option is a no-op without refraction but helps with it.
