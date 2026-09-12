# plan-calc

A local-first web app for working with floor plans in the browser: **measure** an
uploaded plan, or **build** a simple 2D model of it (walls, openings, rooms). No server,
no account — everything lives in the browser's IndexedDB for the address you are on.

## Platform

The app opens on a **dashboard** of **projects**. A project is a workspace that owns a
plan (the *underlay*) and its annotations, and it can be opened with one of two tools:

| Tool | What it does |
| --- | --- |
| **Measure** | Calibrate the scale, draw **dimensions** (cotas) and **spaces** (named/typed areas), and read measurement totals. |
| **Build** | Model the plan: **walls** (a node graph, so corners move together), **openings** (doors/windows) and **rooms**, with quantities. |

Both tools share the project's **underlay and calibration**, so you upload a plan once.
Switch tools from the app bar; the dashboard lists every project with its name and
last-edited time.

- **New from plan** → creates a project from an image/PDF and opens it in Measure.
- **New model** → creates a blank project (no underlay) and opens it in Build.
- In Build, **Import plan from Measure** re-applies the project's plan and scale.

## Measure tool

1. **Calibrate** (key `2`) — drag across the graphic scale bar (or any length you know)
   and type its real value and unit. This stores `px / m`; everything is pixel distance
   internally, converted to millimetres for display. You can also calibrate from a **known
   dimension**: select a dimension, type its real length in the Scale panel and press
   **Set**.
2. **Dimension** (key `3`) — drag from point to point, labelled in mm. `Shift` locks the
   angle to 45°; `Snap` (`S`) aligns to points and to horizontal/vertical/existing lines.
3. **Space** (key `4`) — pick a type (Living room, Bedroom, Kitchen, …, or Measurement) and
   tap points to build a polygon; tap the first point (or `Enter`) to close it. Typed rooms
   add up to the **Useful area**; `Measurement` polygons are free areas. Each row can be
   named and re-typed.
4. **Summary** — measured/useful area by room type, **Export CSV** and **Export PNG**.
5. **Edit** — with the Pan tool, select a dimension and drag its ends/body, or select a
   **space** and drag it as a whole or by its vertices; the **calibration line** can also be
   dragged by its ends or body.
6. **Project → Export/Import file** — a `.json` backup of the whole project.

## Build tool

Draws over the plan (or a blank sheet) and keeps a small **model**:

- **Wall** (key `3`) — drag; endpoints become shared **nodes**, so two walls that meet move
  together. Type and thickness (mm) come from the Walls panel.
- **Opening** (key `4`) — drag a door/window width.
- **Room** (key `5`) — tap a polygon, name it and type it.
- **Pan** (key `1`) — select; drag an element to move it, or drag a node/wall/vertex/opening
  handle to edit it. Walls share **nodes**, so dragging a corner moves every wall that meets
  there.
- **Quantities** — useful area, wall footprint, built area (estimated = useful + wall
  footprint), wall length and opening count, with **Export CSV**.

Walls and openings need a calibration to report real units; without it they are still
drawn but quantities read as unavailable.

## Layers

Every annotation group has a **Hide/Show** toggle in the panel: Dimensions, Spaces (in
Measure), Walls, Openings, Rooms (in Build). A hidden layer is not drawn, cannot be
selected and does not act as a snapping target. Each layer can be cleared on its own;
clearing dimensions keeps the calibration.

## Persistence

Projects are stored in **IndexedDB**, which is tied to the exact **origin**
(`scheme://host:port`) and the browser profile — the same project is only visible from the
same URL and the same device. The dashboard's **Export/Import file** moves a project
between devices. Data saved by older versions (a single implicit project) is **migrated
automatically** into a project named after the plan on first load.

## Keys

| Input | Action |
| --- | --- |
| `1` / `2` / `3` / `4` / `5` | Tool per the active toolbar (Pan / Calibrate / Dimension or Wall / Space or Opening / Room) |
| `Enter` (polygon tools) | Close the polygon |
| `Shift` (while drawing) | Lock angle to 45° |
| `S` | Toggle snapping |
| `F` | Fit to screen |
| `H` | Show / hide the info panel |
| `Delete` | Delete the selected element |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

## Project structure

| Path | Responsibility |
| --- | --- |
| `src/main.js` | Shell: dashboard, project CRUD, tool switching |
| `src/storage.js` | IndexedDB: projects, documents, legacy migration (WebKit-hardened retries) |
| `src/project.js` | Project/document model and migration mapping |
| `src/layers.js` | Layer visibility defaults |
| `src/model.js` | Space/wall/opening types and quantity calculations (take-off) |
| `src/measure.js` | Pure geometry, units and snapping math |
| `src/render.js` | Canvas painting shared by both tools |
| `src/source.js` | Underlay loading (image / PDF page) |
| `src/core/canvas.js` | Pan/zoom/gesture/loupe controller shared by the tools |
| `src/core/ui.js` | Toasts, dialogs, downloads |
| `src/tools/measure.js` | The Measure tool |
| `src/tools/build.js` | The Build tool |

## Development

```sh
npm install
npm run dev      # dev server
npm test         # node --test (pure logic + storage with fake-indexeddb)
npm run build    # production build
npm run preview  # preview the build
```
