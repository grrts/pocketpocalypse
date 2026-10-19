# Art style and scale

This is the target look for the street-level game. Build new art to it, and
move existing art towards it. The country map and the intro flight from space
keep the map look; everything you see while playing on foot does not.

The problem we are fixing: the play view looks like a printed map. Flat
land-use colours, roofs as coloured polygons, a player sprite about 2.6 m wide
(a quarter of a house). It should look like a place people lived in a few
months ago, seen through a game.

## 1. Pillars

We sit between three references and take one thing from each.

| Reference | What we take | What we leave |
| --- | --- | --- |
| GBA-era Pokémon (Ruby/Sapphire, FireRed) | Clean, readable shapes. Trees as round canopies on visible trunks. Flowers, fences, hedges, mailboxes. Cosy, saturated base colours. Height shown by a front face. | Tile grid, chunky scale, buildings as tiny props. |
| Project Zomboid | Real-world scale. Every house enterable; roof disappears when you go in. Rooms full of furniture and clutter. Decay over time: litter, blood, overgrowth, broken windows. | Isometric camera, brown-grey everything. |
| Foxhole | Straight top-down. Muted, weathered realism. Visible damage: craters, burnt shells, rubble. Readable at a distance. | Military-only palette, no warmth. |

**Where we land:** Pokémon's readability and warmth, Zomboid's scale and
interiors, Foxhole's camera and wear. Start from a pleasant Dutch town, then
weather it: the base palette is warm, and decay is added on top (desaturate,
add dirt, overgrowth and damage). It is never grey by default.

## 2. Camera and projection

- **Top-down with a light 3/4 cheat.** The camera looks straight down, but
  anything with height is drawn rising *up the screen* (towards north) from
  where it stands. You see the south facade of a building, the trunk of a tree
  and the front of a person.
- **The ground truth stays the map.** Footprints, roads and collision are the
  real geometry. Height is only drawn, never collides. Everything with height
  is anchored at its base: feet for people, trunk base for trees, the south
  edge for walls.
- **Facades sit inside the footprint.** The south facade strip is drawn along
  the southern edge of the footprint, and the roof takes the rest. Nothing is
  drawn outside a footprint, so a building never hides the street south of it.
  Strip height: 0.5 × wall height, capped at one storey (1.5 m on screen).
- **Draw order:** ground, then ground decals, then all standing things sorted
  by base y (south draws last), then canopies and roofs, then weather, then UI.
- Heading-based sprites are not rotated freely. People and zombies use
  direction frames (section 8). Only vehicles, corpses and loose items rotate.

## 3. Scale

Everything is built to these numbers. If art does not fit them, the art is
wrong.

**World units**

- 1 world texel = one Web Mercator zoom-18 pixel ≈ **0.37 m** in the
  Netherlands (0.597 m × cos 52°). Material ids and collision live on this grid.
- 1 **art pixel** = ¼ texel ≈ **0.09 m**, so **11 art px per metre**. All
  hand-drawn detail (characters, props, trees, ground detail, facades) uses
  this one grid.

**Camera**

- The play camera shows about **26 m across the short side of the screen**.
  That is zoom ≈ **20.5** on a phone (≈ 400 CSS px short side) and ≈ **21.5**
  on desktop (≈ 800 px). `defaultPlayZoom` should be derived from this rule,
  not hard-coded.
- At those zooms one art pixel is about 1.4 CSS px on a phone and 2.8 px on
  desktop. Snap to whole device pixels where possible; never smooth-scale art.

**Real sizes** (art px at 11 px/m in brackets)

| Thing | Size |
| --- | --- |
| Person | 0.7 m across the shoulders (8 px), 1.8 m tall (drawn about 18 px high) |
| Door | 0.9–1.1 m wide (10–12 px); double/shop doors 1.8–2.4 m |
| Window | 1.0–1.5 m wide |
| Building storey | ≈ 3 m |
| Car | ≈ 4.5 × 1.8 m (50 × 20 px); van 5.5 × 2.0 m; bus 12 × 2.5 m |
| Bicycle | 1.8 × 0.6 m |
| Street tree canopy | 4–8 m across |
| Forest / park tree canopy | 6–12 m across |
| Trunk | 0.3–0.6 m across, 2–3 m visible below the canopy |
| Bush | 1–2 m |
| Hedge | 0.6–1.0 m deep, 1–2 m tall |
| Residential street (Dutch erf) | 5–7 m wall to wall incl. parking |
| Lane | ≈ 3 m; bike path 2–3 m; sidewalk 1.5–2.5 m |

The test: a person standing at a front door is a bit taller than half the door
height in the facade, a car is about as long as a terraced house is wide, and
four people fit side by side on a residential street.

**One resolution per object.** A single object uses a single pixel size. No
object mixes art pixels with texel-sized blocks, and nothing is drawn at 2× or
½× of the art grid. Ground colour fields may live on the texel grid, but any
detail on top (grass tufts, brick pattern, cracks) is drawn on the art grid,
finer than one material texel.

## 4. Palette

Warm but weathered. These are the base values; ±6% value noise and a few
accent pixels per tile is expected. Decay shifts them (section 4.1).

| Use | Hex |
| --- | --- |
| Grass base / light / dark | `#6f9a3f` / `#8cb54c` / `#4f7430` |
| Dry / trampled grass | `#a89b5a` |
| Flowers (accents) | `#e8d84a` `#e06a5a` `#f0ece0` `#9a7ad0` |
| Foliage light / mid / dark | `#7fae4a` / `#4f8a3a` / `#2e5a2c` |
| Conifer foliage | `#2f5a3e` |
| Trunk / bark shadow | `#6b4a2f` / `#433021` |
| Klinkers (red brick pavers) | `#9a5a44`, joints `#6e4334`, light `#b06c52` |
| Asphalt / worn asphalt | `#4a4a4e` / `#5c5b5c` |
| Road marking (aged white) | `#d6d2c2` |
| Red bike asphalt | `#9c4b40` |
| Sidewalk tiles (stoeptegels) | `#a8a39a`, joints `#86827b` |
| Curb | `#bdb8ae` |
| Canal water / deep / highlight | `#3f6a72` / `#2c4f58` / `#7ea6a6` |
| Quay wall brick | `#7a4a3a` |
| Roof tiles red / brown / anthracite | `#a4513b` / `#7a4b34` / `#3e4048` |
| Flat roof bitumen / gravel | `#5a5753` / `#8d877c` |
| Facade brick (typical Dutch) | `#8e4f3c`, mortar `#c9b8a0` |
| Window glass | `#5d7a86`, reflection `#a9c3c8` |
| Floor wood / tile / carpet / concrete | `#a0764a` / `#c8c2b4` / `#6e6a78` / `#8e8b85` |
| Interior wall top | `#e4ddcf` |
| Blood fresh / dried | `#8a1c1c` / `#4e1a16` |
| Fire core / mid / edge, ember | `#ffe28a` / `#f29a2e` / `#c4471d`, `#ff6a2a` |
| Soot / burnt | `#2b2725` |

### 4.1 Decay and overgrowth

The world is 75 days into the outbreak. Decay is a per-place value (from the
simulation's damage and time) that drives:

- Grass grows longer and spreads into cracks of paving and road edges.
- Weeds and ivy on facades and fences; hedges lose their clean edge.
- Litter, leaves, dropped bags, blood trails near fights.
- Colour: up to −20% saturation and a slight brown-grey shift on built
  surfaces. Vegetation gets *more* saturated and wilder, not less.

## 5. Lighting

- **Fixed sun from the north-west.** Shadows fall to the south-east.
- Drop shadows are soft-edged, about 35% black, blended multiply. Length
  follows height: 0.5 × height for walls, trees and people, capped at 6 m.
- Top-lit surfaces: north-west edges get a 1-px highlight, south-east edges a
  1-px shade. No black outlines.
- **Overcast** is the Dutch default: a light grey-blue tint over the scene
  (about 10%) and shorter, softer shadows. Clear sun is the exception.
- Night comes later: a dark blue multiply, light pools from fire, torches and
  car lights. Design colours so they still read under that.

## 6. Ground materials

Each material is a base colour field plus detail on the art grid.

- **Grass:** base with tufts (2–4 px clusters, light and dark), scattered
  flowers in parks and verges, darker patches under trees, worn paths where
  people walked.
- **Residential streets (klinkers):** red brick pavers in herringbone or
  stretcher bond, 1 brick ≈ 0.2 × 0.1 m drawn as 2 × 1 px marks with joint
  lines. Parking bays in a slightly different brick. Gutters as a grey row.
- **Main roads:** asphalt with grain, a 1-px raised curb, white lane markings,
  zebra crossings, shark teeth at junctions. Patches and cracks with decay.
- **Bike paths:** red asphalt, with a white edge line where beside a road.
- **Sidewalks:** 30 cm square tiles, light grey, a few broken or missing.
- **Canals and water:** water with slow ripple highlights and a darker edge;
  quay walls as a brick strip with a stone capping on the land side. Ducks,
  houseboats and floating debris as props.
- **Gardens:** grass or tiles, a hedge or fence along the front, a shed, a
  trampoline, bins. Back gardens are fenced in wood.
- **Farmland:** crop rows following the field's long axis, a ditch (sloot)
  of water along field edges, bare earth patches.
- **Forest floor:** dark earth with needles or leaves, ferns, fallen branches.
  The trees on top are objects (section 7), not ground colour.

Land-use classes (residential, commercial, industrial) are not colours. They
choose which ground materials and props appear.

## 7. Vegetation

Trees and bushes are **objects**, placed from land use, OSM tree points and
tree rows, not painted into the ground.

- **Tree:** trunk at the base point, round canopy above it (shifted up by the
  trunk height in the 3/4 cheat), shadow to the south-east.
  - The **trunk collides** (a 0.5 m circle). The canopy does not.
  - The canopy draws above people. When the player is under it, it fades to
    about 30% opacity in a soft circle around them.
- **Canopy shape:** 3 tones (light top-left, mid, dark bottom-right), lumpy
  edge of 3–5 bumps, never a perfect circle. Conifers: darker, more pointed.
- **Bushes:** 1–2 m round clumps, solid but low (block movement, do not hide
  you). Some have flowers or berries.
- **Hedges:** follow garden borders as strips with a flat top and darker
  south face. They block movement.
- **Street tree rows:** Dutch residential streets get a row of trees along one
  or both sides every 8–12 m, on the sidewalk or parking strip, same species
  along one street.
- **Variety:** at least 4 deciduous and 2 conifer shapes, plus size ±20% and a
  hue shift ±5% per tree from its position hash. No two neighbours identical.
  Forests are dense (canopies overlapping 20–30%) with small gaps.

## 8. Buildings

- **Roof:** readable by type at a glance.
  - Pitched tile roof: tile rows along the ridge, a ridge line, light/dark
    halves for the two slopes.
  - Flat roof: bitumen or gravel with vents, AC units, skylights, edge trim.
  - Industrial: corrugated metal with long ribs. Glass: greenhouse grid.
- **South facade strip** (section 2): brick or render, windows with frames
  and sills, front doors with a step. Shops get wide windows and a sign band.
  Doors on other sides are shown as a doormat and gap at the roof edge.
- **Interiors:** almost every building is enterable. When the player is
  inside, the roof of that building fades out over 0.3 s and the floor plan
  shows: floors by room type (wood for living rooms, tile for kitchens and
  bathrooms, carpet for bedrooms and offices, concrete for garages, sheds and
  industry), interior walls 0.15 m thick drawn as a 2-px top with a light
  top face, doorways as gaps, and furniture: beds, sofas, tables, kitchens,
  shelves, toilets, desks. Shops have aisles and counters. Furniture is solid
  and lootable where it makes sense.
- **Damage variants:** broken windows (dark glass with shards), boarded
  doors and windows, scorch marks, burnt shells (roof gone, black floor,
  rubble inside), and partial collapse with rubble spilling into the street.

## 9. Characters and zombies

- **Silhouette first.** At phone size a survivor, a zombie and a soldier
  must be told apart by shape and motion alone: survivors upright with arms
  at their sides, zombies hunched with arms forward and a lurching gait,
  soldiers with a helmet and a rifle line.
- **Sprite frame:** 16 × 24 art px, figure about 8 px across and 18 px tall,
  feet at the bottom centre (the collision point).
- **Directions:** 8 directions; 4 drawn (N, S, E, NE/SE), the rest mirrored.
- **Frames:** idle 2, walk 4, run 4, attack 3, hit 1, death 4. Zombies:
  shamble 4, lunge 3, feed 2.
- **Colour:** clothes in mid tones that stand off the ground; skin readable;
  zombies grey-green skin, dirtier clothes, blood on the front. A 1-px darker
  edge on the shadow side instead of an outline.
- **Corpses** lie flat and rotate freely; they get a blood pool decal.

## 10. UI over the world

- Minimal. HUD in the corners, small, semi-opaque panels.
- One pixel font, rendered at whole multiples of its size.
- No map elements in play mode: no street names, no land-use colours, no
  north arrow. The map look belongs only to the map screen (M) and the
  intro flight.
- Interaction prompts float next to the object, small.

## 11. Don't

- Don't use flat land-use or map colours as the play-mode ground.
- Don't outline buildings, roads or areas like a printed map.
- Don't mix pixel sizes on one object, and don't scale art by non-integer
  factors with smoothing.
- Don't draw trees, bushes or cars as ground colour; they are objects.
- Don't make anything larger than its real size to "read better": scale is
  fixed by section 3. Fix readability with contrast and shape.
- Don't use pure black or pure white anywhere except UI.
- Don't use external map imagery (satellite, map tiles) in the game.
- Don't let decay make the world uniformly grey-brown; keep warm bases.
