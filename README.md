# Pocketpocalypse

A top-down pixel-art zombie survival game played on the real map. This is the
first playable proof of concept, limited to the Netherlands.

Pick any spot in the country on a map seen from space, fly down to street level,
and wake up 75 days into an outbreak. Roads, buildings, canals, land use and
terrain come from real geographic data. The state of each place (how hard it was
hit, whether it was evacuated, burned or held by the army) comes from a seeded
simulation of how the outbreak spread between real cities. What you change stays
changed when you come back.

## Running it

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/
npm test             # unit tests (vitest)
npm run e2e          # browser smoke test (playwright, runs offline on baked data)
```

Useful URL parameters: `?autostart=1&spawn=5.1214,52.0907` skips the menu,
`seed=` fixes the world seed, `geo=baked` turns off live Overpass fetches,
`geo=overpass` fetches street data live instead of using the baked bundles,
`fast=1` shortens the flight, `continue=1` resumes the saved world, `debug=1`
shows the debug overlay (also F3).

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | Move |
| Shift | Sprint |
| Mouse click | Attack (melee arc, or a shot with a gun equipped) |
| E | Search the nearest building, car, body or crate |
| F | Take everything from the open container |
| I / Tab | Inventory (eat, drink, bandage, equip, drop) |
| M | Country map |
| Mouse wheel | Zoom |

When you die your body stays where you fell with everything you carried. You
wake up as the next survivor at your spawn point and can go back for it.

## How it fits together

```
src/core      geo maths (Web Mercator, z18 "texels" ≈ 0.37 m in NL), seeded RNG and noise
src/country   CountryProfile per country: data URLs, spawn presets, army bases, entry points
src/data      map data sources: overview pack, Overpass, baked Overpass tiles, elevation
src/sim       outbreak simulation over real cities, frozen at "day 75" for single-player
src/world     chunk generation: rasterise map data, damage it, populate it
src/render    id rasteriser, material table (colour + texture + collision), sprites
src/worker    web worker entry: generates chunks and overview tiles off the main thread
src/engine    camera and fly-to, chunk streaming, overview pyramid, worker pool, renderer
src/game      items and loot tables, player, zombies, combat, death and respawn
src/persist   key-value storage (IndexedDB) and the WorldStore save contract
src/ui        DOM overlay: menus, HUD, loot and inventory panels
```

**Rendering and LOD.** The world is drawn in two layers. From space down to
roughly district level an overview pyramid of raster tiles (z2–z16) is rendered
from a prebuilt country pack and Natural Earth land, falling back to coarser
ancestor tiles while finer ones load. Below that, street chunks (z16 tiles, 1024
× 1024 texels, about 380 m across) are streamed around the camera and the player
and fade in over the overview. Both layers go through the same no-antialias
scanline rasteriser, which writes material ids; one material table turns those
into colours, procedural texture, shadows and the collision grid.

**Map data.** The whole country is baked ahead of time into map bundles
(`public/data/nl/geo`, one PNG-wrapped bundle per z10 tile, about 300 MB for
NL). They hold every building footprint with its height or floor count, every
road and path with its class and width, rail, water, land use and shops, taken
from an Overture Maps extract (which carries OpenStreetMap and the Dutch BAG
building register). Outside the bundles, street detail falls back to the
Overpass API at runtime (or always, with `geo=overpass`) and is cached in
IndexedDB. A Sentinel-2 summer colour mosaic (`public/data/nl/sat`, 20 m
pixels) tints fields, heath, dunes and forest the way they look from orbit,
both in street chunks and in the overview. The overview pack
(`public/data/nl/pack`) holds land cover, water and major roads at z5/z8/z10.
Elevation comes from AWS Terrain Tiles and is used for hillshade and to flood
polders below sea level; it needs network access.

If the data folder holds an `assets.json` mapping data paths to URLs, the game
loads files through it, which lets a host keep the bundles in a separate
blob store.

**Generation and persistence.** Every chunk is generated deterministically from
the world seed and its coordinates, so unvisited places cost nothing to store.
Only differences are saved, per chunk: opened containers, killed or moved
zombies, dropped items. Player bodies are stored with the world. All storage goes
through `KeyValueStore` / `WorldStore` (`src/persist`), which a server-backed
implementation can replace.

**Extending to other countries.** Country-specific parts are a `CountryProfile`
(`src/country`) plus a data pack. To add one:

1. Add the country's bounding box to `tools/geobake/countries.py`.
2. Bake the overview pack from Overture Maps (needs `pyarrow`, `shapely`, `s3fs`):
   `python3 tools/geobake/build_pack.py --country be --out public/data/be`.
3. Download the country's Overture layers once (about 5 GB for NL), then bake
   the map bundles:
   `python3 tools/geobake/extract.py --country be --out .geobake-cache/be`, then
   `python3 tools/geobake/bake_bundles.py --src .geobake-cache/be --out public/data/be/geo --manifest public/data/be/manifest.json`.
4. Build the satellite mosaic (needs `rasterio`; pass the Sentinel-2 grid squares
   covering the country): `python3 tools/geobake/sentinel.py --country be --out public/data/be/sat --squares 31UES ...`.
5. Write a profile like `src/country/nl.ts` and register it in `src/country/registry.ts`.

**Multiplayer readiness (not implemented).** The outbreak history is plain data
generated once per world, chunk generation is a pure function, spawn ids are
stable, and saves are per-chunk deltas behind an interface, so a server could own
the history and the deltas while clients keep generating terrain locally.

## Data sources and attribution

- Map data © OpenStreetMap contributors, ODbL, via the [Overpass API](https://overpass-api.de) and [Overture Maps Foundation](https://overturemaps.org)
- Buildings include the Dutch [BAG](https://www.kadaster.nl/zakelijk/registraties/basisregistraties/bag) register as imported into OpenStreetMap, via Overture
- Land cover © ESA WorldCover (via Overture base theme)
- Satellite colour: contains modified Copernicus Sentinel data (2024–2025), from the [Sentinel-2 COGs on AWS](https://registry.opendata.aws/sentinel-2-l2a-cogs/)
- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen Terrarium)
- Coastlines for the space view: [Natural Earth](https://www.naturalearthdata.com) via `world-atlas`

## Known limits

- The public Overpass servers rate-limit. Outside the baked areas, a new place
  can take a few seconds to appear, and a busy server can leave it showing only
  the overview layer until you move again.
- Sprites are procedural placeholders.
- Between zoom 15 and 16 the overview is drawn from the z10 pack and looks soft.
- The map bundles and satellite mosaic are not in git (they are a few hundred MB);
  bake them with the steps above.
- Hosts that refuse `.json.gz` files can serve an uncompressed copy made with
  `python3 tools/stage-plain.py dist <out>`.
