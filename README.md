# riverIsland

An Observable Notebook Kit recreation of *riverIsland* (John Cayley, 1999- ; QuickTime version 2008), a navigable text
movie composed from transliteral morphs, with a spatialised aural environment. Co-implemented with Claude Sonnet 5.5 on Sunday 25 October 2026.
The notebook entry point is `nbks/index.html`.

## Commands

- `npm run preview` — local preview at http://localhost:5173
- `npm run build` — build to `dist/`
- `python3 tools/extract.py` — regenerate `nbks/data/` from `raw/riverislandQT/` (needs `ffmpeg`; `raw/` is not tracked)
- `python3 tools/subset_font.py NotoSerifTC[wght].ttf` — regenerate the Chinese font subset (needs `pip install fonttools brotli`)

## Reading riverIsland

Click one of the two movies (the panorama along the bottom, the vertical object movie at the left) to wake it; this also
starts the sound. Hold the mouse button over an arrow in the lower right to step from one nodal text to the next, by way
of a transliteral morph (a node is reached after 14 steps; leave the arrow and come back to go on). Or drag a movie, and
when you let go a dot appears among the arrows: click it and the text morphs to the node that matches where you are.
At vertical nodes 4, 6 and 11 the central icon becomes a button for one of the three *kong* movies with interliteral
graphic morphs; click the centre again to return to the text. `m` mutes.

## How the original works (and where it lives here)

`riverisland.mov` is a master movie composing the pieces below; its scripts are LiveStage wired actions, and the text
processing uses the third-party QSXE component, so none of it runs in a current QuickTime. Everything was recovered from
the movies' structure (see `workingnotes.md`).

| Original | Here |
| --- | --- |
| `periplus.mov` — 360° panorama, 16 nodes 22.5° apart, with 16 embedded readings (`s0`…`sf`) | `pano/periplus.jpg`, `audio/h01…h16.mp3`; WebGL viewer `panorama.js` |
| `paths.mov` — object movie of 192 frames (12 per node, 16 nodes), 16 embedded readings (`p0`…`pf`) | `obj/g00…g15.jpg` (12 frames per sheet), `audio/v*.mp3` |
| `ri` sprite track — the 32 node texts, their word keys, and the navigation script | `texts.json`, `river.js` |
| `stepper` sprite track — the morph | `morph.js` |
| `periRiCntrl`, `pathsRiCntrl` — the sound of each node follows the angle of view | `audio.js` |
| `riAtmos.mov` — ambient loop (about 8.7 minutes) | `audio/atmos.mp3` |
| `riLtw5`, `riPyw5`, `riZiw5` — the interliteral movies | `video/kong-lt.mp4`, `kong-py.mp4`, `kong-zi.mp4` |

## Differences from the original

- The morph runs one step every 750 ms (`STEP_MS` in `nbks/data/river.js`), a value chosen by the author: the `ri` track's idle frequency is 90, which I had read as milliseconds. A click on an arrow is one step; holding goes on stepping. The panorama and
  object movie glide smoothly between steps instead of jumping on each step.
- Fonts are bundled, so the piece looks the same on every system. The original text is Courier New 24 pt; here the Latin
  text is **Courier Prime** (Google Fonts, a Courier-like typewriter face), with **Cousine** (Google Fonts, which has exactly
  Courier New's character widths) bundled as the fallback and for future development. All characters of the roman texts have
  one and the same width (Courier Prime's is 0.5996 em, Courier New's 0.6 em: 14.39 px against 14.40 at 24 px), so the grid
  of every text, and of every morph between them, stays consistent; it does not have Courier New's exact metrics. The
  Chinese text (Big5 bytes in the original, two bytes = two cells, decoded with the browser's Big5 decoder) is set in a small
  subset of **Noto Serif TC** (`nbks/data/fonts/`, made by `tools/subset_font.py`; see `workingnotes.md`). Three rarely seen
  symbols (␅ ␓ ␕) are not in any of them and come from the system if they appear. Two slips in the original Chinese text are
  corrected by `tools/extract.py`: 炙 (`AA A5`) is 返 (`AA F0`), and 照 is moved one column left, onto the column of the other
  second characters (see `workingnotes.md`).
- The readings are mixed differently from the original. There, a reading is audible within 33.75° of the view, wider than the
  22.5° between nodes, so at a node you also hear its two neighbours. Here a reading is audible only within 22.5°: at a node
  you hear that node's reading alone, and between two nodes only those two, one fading as the other rises in proportion to the
  distance (`nbks/data/audio.js`, on both the horizontal and the vertical circuit).
- The sound waits for a click (browsers require it); the original starts the ambient loop by itself once loaded.
- The grey veil on an inactive movie is a plain translucent grey.
- Dragging sensitivity is chosen, not recovered: the panorama follows the pointer, the object movie turns 90° of our angle
  (45° of tilt) over the height of its window.
- Interliteral movies can be left at any time with the centre icon; the original waits for the movie to finish.
- The accompanying essay (`ri4IoRW.doc`, Cayley's prefatory remarks for *The Iowa Review Web*) and the START_HERE page are not
  reproduced in the notebook.
