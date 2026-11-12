# Challenge targets: summary

What the viewer shows for the five targets of the NASA Space Apps 2026 challenge "Planet X and SPHEREx", plus the
Orion Nebula as a bonus. Each folder has 1366×768 screenshots, a blink GIF where the change is visible, and a
README with reproducible URLs and numbers. SPHEREx pixel = 6.15″.

| Target | What we looked for | Visible? | Evidence | Note |
|---|---|---|---|---|
| [Barnard's Star](barnard/) | proper motion, Aug 2025 → Aug 2026 | **Yes** | Blink / Diff dipole in D6. Measured −1.47 ± 0.15″, +10.19 ± 0.07″ (10.3″ = 1.67 px) vs Gaia −0.79″, +10.26″. Per-epoch S/N 15 000–18 800. Spectrum compare: no brightness change (D5–D6 ×1.02) | D1–D4 saturated; the 0.7″ RA offset is within the ~0.5–1″ systematic limit |
| [Epsilon Indi B](epsindi/) | proper motion, Apr 2025 → Sep 2026 | **Yes** (≈ 1 px) | Diff dipole towards the south-east in D6. Measured +5.03 ± 0.47″, −4.02 ± 0.22″ (6.4″ = 1.05 px) vs Gaia +5.60″, −3.47″ (2.5σ). D5 agrees (2.1σ). S/N 96–394 per epoch | Ba / Bb not resolved; the shift is about one pixel, subtle in the blink |
| [WISE 0855−0714](wise0855/) | proper motion, Nov 2025 → Apr 2026 | **No** (detected only at the limit) | Per-epoch S/N 5.0 / 5.0 (D6). Expected 3.7″ = 0.6 px; measured −1.97 ± 1.28″, +0.85 ± 1.30″ (error ≈ motion). The Diff pair at the crosshair is at the noise level. Shift-and-add of 40 frames: S/N 5.3–5.8, motion not constrained | Y dwarf at the SPHEREx limit; motion < 1 px between well-covered epochs; the D1–D2 "brightening" in the spectrum window is background, not the object |
| [RW Aurigae](rwaur/) | brightness change, Sep 2025 → Sep 2026 | **Yes** | Blink with the same contrast and a Diff "vanished" blob in D6. Spectrum compare: D5 ×0.54 ± 0.02, D6 ×0.54 ± 0.03 (−46%); D1 ×2.09 ± 0.26, D2 ×1.37 ± 0.08 (brighter); D3–D4 no clear change. D6 vs field stars: −30% (Feb 2026), −50% (Sep 2026); controls 5.4% | A and B are blended (1.4″); at 4.7 µm the centroid sits on B, so we cannot tell which component changed |
| [R Draconis](rdra/) | brightness change, Apr 2025 → May 2026 | **Partly** (visible, amount uncertain) | Blink with the same contrast, Diff halo at noise scale ×8.3. PSF-wing photometry in D6: −44% (May 2025 → May 2026), range 79% vs controls 4.8% | Core saturated in all detectors; the Spectrum window has no unsaturated detector in both visits; the epochs mix bands; the ~245-day Mira period is not seen |
| [Orion Nebula](orion/) (bonus) | spectral features | **Yes** | Area of 18.5″ with the Sky-model background: Paα 1.875 µm ×5.8 (24.2σ, confirmed in a 2nd visit at 26.2σ), PAH 3.29 µm ×4.4 (29.3σ) | With a Ring background the same circle gives "No point source found here" and upper limits |

## How it was made

- **Pictures.** Taken with `docs/ui/tools/target_screens.py`, which drives the local server in headless Chrome at
  1366×768 and builds the GIFs from the two stacks.
- **Numbers.** Motion and brightness come from `demo/target_check.py` (2026-11-07, `docs/results/target_check_2026-11-07.md`);
  the flux ratios come from the Spectrum window.
- **URLs.** They point to <https://blink-comparator.de>. The screenshots were taken from the current branch; the
  Spectrum window there (Ring / Sky-model switch, one-line comparison) appears on the site after the next
  deployment.

## Not achieved

- **WISE 0855.** Its motion is not demonstrated: the object is at S/N ~5 per epoch, and the shift between
  well-covered epochs is 0.6 px.
- **R Draconis.** There is no clean per-detector flux change: the star is saturated everywhere, and the −44% rests
  on a PSF-wing method that still needs an independent check.
- **RW Aurigae.** The change cannot be assigned to component A or B.
