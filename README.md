# plan-calc

Local-first tool to measure a plan and paint **real dimensions (cotas)** over it.
Everything runs in your browser — no upload, no server, no network after install.

Use it when a plan only carries a **graphic scale**: calibrate once against that
scale bar, then drag dimensions anywhere on the plan and read them in **millimetres**.

## Run

```bash
npm install     # once
npm run dev     # http://localhost:5173
```

Production build (still fully local):

```bash
npm run build
npm run preview
```

Tests for the measurement math:

```bash
npm test
```

## Workflow

1. **Open plan** — an image (PNG/JPG/WebP) or a PDF (multi-page supported).
2. **Calibrate** (key `2`) — drag across the graphic scale bar, then type its real
   length and unit. This stores `px / m`; everything internally is pixel distance,
   converted to millimetres for display.
3. **Dimension** (key `3`) — drag from point to point. Each dimension is labelled in
   mm. `Shift` locks the angle to 45° steps; endpoints snap to existing points. The
   **Snap** toggle (`S`) also snaps the angle to horizontal, vertical or any existing
   dimension/calibration line, so a diagonal drag still comes out parallel.
4. **Select / delete** — with the Pan tool, click a dimension or the calibration line
   to highlight it; a red `×` appears. Clicking it (or `Delete`) opens a small
   confirmation before removing the line. Changes are undoable with `Ctrl+Z`.
5. **Export PNG** — writes the annotated plan to a file. Projects (raster, calibration
   and dimensions per page) are auto-saved in IndexedDB and restored on reload.

## Keys and touch

| Input | Action |
| --- | --- |
| `1` / `2` / `3` | Pan-Select / Calibrate / Dimension |
| `Shift` (while drawing) | Lock angle to 45° |
| `S` | Toggle angle snap (grid + existing lines) |
| Click a line | Select it (shows `×` to delete) |
| Draw with touch | A magnifier above your finger shows the exact end point |
| Two-finger drag | Pinch to zoom and pan (touch) |
| `Space` or middle-drag | Pan |
| Wheel | Zoom at cursor |
| `F` | Fit to screen |
| `H` | Show / hide the info panel |
| `Delete` | Delete selected (asks to confirm) |
| `Ctrl+Z` | Undo |

The **Info** button (or `H`) shows the side panel with the scale, the dimension list
and the delete/clear actions; it starts closed so the plan has the full area, and the
button carries a badge with the number of dimensions. The top bar stays on a single
line and scrolls horizontally if the screen is too narrow.

## How the math works

- `computePxPerMeter(a, b, realMeters) = distance(a, b) / realMeters`
- `mm = (px / pxPerMeter) * 1000`
- Points are stored in **natural image pixels**, so zoom and pan never change a
  measurement. Changing the calibration recomputes every label.

Numbers are formatted with the **browser locale** on purpose, and the unit adapts to
the size while keeping millimetre precision:

| Value | Shown as |
| --- | --- |
| under 100 mm | `45 mm` |
| 100–999 mm | `12,5 cm` (0,1 cm = 1 mm) |
| 1000 mm and above | `3,9 m` (0,001 m = 1 mm) |

In Spanish, `3,9 m` uses a decimal comma and 4-digit millimetres have no thousands
separator, so a value can never be misread as `3,9 mm` the way an English
`3,900 mm` can.

The calibration value is the **real-world distance the bar represents**, not its
size on screen or paper. A bar drawn "0 … 1" in metres is `1 m`; a bar "0 … 5 m" is
`5 m`. If you measure the bar with a physical ruler you get the on-screen size, which
is a different quantity and will produce wrong dimensions.

All of this lives in `src/measure.js` and is covered by `test/measure.test.js`.

## Structure

| Path | Responsibility |
| --- | --- |
| `src/measure.js` | Pure math: distance, calibration, mm conversion, snapping |
| `src/viewport.js` | Image ↔ screen transforms, zoom, fit |
| `src/render.js` | Canvas drawing of raster, calibration and dimensions |
| `src/source.js` | Image / PDF loading and page rasterisation (pdf.js) |
| `src/persistence.js` | IndexedDB autosave |
| `src/main.js` | State, tools, pointer/keyboard events, UI |

## Notes

- PDF pages are rasterised at up to 5× (capped at 3200 px wide) for precise clicks.
- Dimensions are tracked per PDF page.
- Not calibrated yet? You can still draw, but labels read `set scale first`.
