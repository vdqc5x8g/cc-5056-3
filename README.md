# Glass Compositing Lab

Estimate a fixed transparent product's **transmission**, **chromatic
attenuation** and **additive reflection** from photographs over several **known
backgrounds**, then composite it onto a **new** background — with the model's
limits stated, not hidden.

The declared model is `O_k = T · B_k(x + s + d) + A`. Locally degenerate regions
are reported as **undetermined**, never as transparent. The composite is always
recomputed from the estimated fields; the source photo is never pasted through.

## Graphical entry point (primary)

```bash
npm install
npm run ui
# open http://localhost:5173/
```

Paint the transmission region, estimate, inspect each component and the
reconstruction residual, then composite onto a chosen new background and compare
against a ground-truth reference. Five built-in scenes with ground truth
(`basic`, `threeway`, `degenerate`, `refraction`, `drifting`) exercise the
well-conditioned case, the honest-refusal case, refraction that the model cannot
fully express, and a moved object.

## CLI (auxiliary)

```bash
npm run synth                                   # export synthetic scenes
node tools/glass-cli.js estimate --obs a.png,b.png --bg a0.png,b0.png --mask m.png
node tools/glass-cli.js check    --obs ... --bg ... --mask ...
node tools/glass-cli.js compare  --pred composite.png --ref reference.png
```

## Tests

```bash
npm test
```

See [docs/GLASS_COMPOSITING.md](docs/GLASS_COMPOSITING.md) for the model, the
identifiability gate, the consistency checks, and an explicit list of what the
tool will not do.

## Scope

The model does not capture refraction curvature, caustics, dispersion or
polarisation, and assumes one fixed object with additive background-independent
reflection. A single transparency/alpha cannot represent arbitrary glass optics.
A low residual means the declared model fits the observed backgrounds; it is not
proof that the real material parameters are uniquely known.
