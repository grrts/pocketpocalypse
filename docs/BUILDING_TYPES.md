# Building types of the Netherlands, and how to spot them in our data

Research for `src/world/buildingModel.ts` (clean models on real footprints).
Part 1 is what the baked map actually contains. Part 2 lists the building types a
player meets, and how each should look. Part 3 gives detection rules with concrete
thresholds. Numbers come from a throwaway sampler over `.geobake-cache/geo2`
(3x3 z15 tiles, about 2.2 km square per place; rural places 5x5) and from
`building=` counts over seven whole z10 bundles (about 2.2 million footprints).

## 0. Key facts

1. **Class is nearly useless on its own.** Nationwide, `building=yes` is 35-58% of
   footprints and `house` 35-47%. `apartments` is 1-9% (43% only in Amsterdam).
   Farm, barn, stable, greenhouse, church, warehouse and train-station tags together
   are under 0.5%. Westland has about 1,400 `greenhouse` tags against tens of
   thousands of real greenhouses. **Type must come from geometry plus context.**
2. **One footprint is one BAG "pand", not one block.** Terrace houses, canal houses
   and the bays of a city block are each their own polygon, sharing party walls.
   Terrace members are 5.4-6.8 m wide (median) and 10-12 m deep everywhere. In old
   centres 75-86% of houses sit in one connected party-wall component of more than
   12, which is the whole perimeter block. Long flats can also be split into
   segments.
3. **Half of all `yes` footprints are under 15 m².** They are garden sheds and bike
   sheds behind terraces (Vinex 68-73%, Utrecht 57%). They touch fences and the
   house, so they must be left out of terrace and row detection.
4. **Levels are rare. Height is patchy.** `building:levels` covers 0.4-9.5% per
   bundle (Bijlmer 48%). `height` covers 0-79% (Amsterdam 79%, Achterhoek 40%,
   Friesland and Flevoland 0%). `levelsOf()` turns height into `round(h/3)`. That
   counts the roof space of pitched houses as an extra storey (a 9 m house becomes
   3 storeys).
5. **Duplicates and overlaps.** In the Rotterdam port, 68% of footprints overlap
   another footprint, and 661 of 1,934 are round (oil and storage tanks). Friesland
   farmland has 31% overlap and Veluwe 9%. Cities are about 1%. Dedupe before
   modelling.
6. **Landuse under a building tells you little.** `landuse=residential` covers
   80-100% of buildings, including farmyards in Noord-Holland. Useful signals are
   `farmyard` (Friesland 20-57% of large barns), `greenhouse_horticulture` (shown
   only as `farm` after `classifyArea`), `industrial` (port 94%), and *no landuse
   at all* (rural farmsteads 47-80%).
7. **A POI swaps the class.** chunkgen replaces `cls` with the POI class. That makes
   13% of Amsterdam canal houses `shop` or `food_service`, which then get the
   2-storey default. The model should keep the *form* class (from geometry and the
   raw tag) and treat the POI as *ground-floor use*, which means a shopfront.
8. **Tags that silently become `other`:** `houseboat` (4% of Amsterdam), `static_caravan`,
   `storage_tank`, `bunker`, `boathouse`, `allotment_house`, `silo` and `cabin` are
   missing from the `BUILDING` map in `src/data/osm.ts`. `roof` and `service` become
   `shed`, but `roof` is mostly petrol-station canopies, platform roofs and carports
   (median 35 m², p90 492 m²).

## 1. What the data contains, by place

`det/semi/row/blk` is the share of house-sized footprints (`house`, or `yes` with
40-200 m²) whose party-wall component (members of at least 25 m² only) has 1, 2,
3-12 or more than 12 members. Area and aspect are for all footprints (aspect = long
side / short side of the box in the dominant axis).

| Place | n | Main tags | lv / h tag | Area med / p90 m² | Aspect med | det/semi/row/blk % | Notes |
|---|---|---|---|---|---|---|---|
| Amsterdam canal ring | 12.7k | apt 43, yes 29, house 15, houseboat 4 | 8 / 79 | 79 / 262 | 2.31 | 1/0/9/86 | 4,235 POIs; widths 6.1 m, depth 13.8 m, aspect 2.3 |
| Utrecht centre | 17.7k | house 45, yes 27, apt 18 | 3 / 5 | 57 / 155 | 2.04 | 2/1/19/76 | 1,718 POIs; 50% of `yes` < 15 m² |
| Utrecht residential | 19.7k | house 41, yes 23, apt 18, shed 11 | 5 / 4 | 51 / 128 | 1.87 | 1/1/25/72 | rows 5.7 x 10.8 m |
| Leidsche Rijn (Vinex) | 6.4k | house 45, yes 29, shed 20 | 1 / 7 | 49 / 101 | 1.58 | 10/8/55/27 | rows 5.9 x 10.8; detached 98 m² |
| Vathorst (Vinex) | 13.5k | yes 51, house 46 | 1 / 0 | 49 / 99 | 1.67 | 9/13/59/19 | rows up to 79 long (sheds join them) |
| Giethoorn | 1.2k | yes 56, house 41, caravan 3 | 0 / 0 | 53 / 158 | 1.52 | 57/20/23/0 | detached 108 m² |
| Oirschot (Brabant village) | 7.8k | yes 52, house 45 | 0 / 24 | 52 / 140 | 1.55 | 27/13/57/2 | old core plus postwar rows |
| Schermer / Beemster (NH) | 0.5-4.8k | yes 50, house 45 | 0 / 0 | 50 / 150 | 1.5 | 30-48/17-30/22-53/0 | 54 square-ish footprints over 200 m² (stolps) |
| Flevoland polder 5.62,52.55 | 180 | yes, house | 0 / 0 | 61% of `yes` 40-150 | – | 20/19/61/0 | 5.5,52.6 is open water (0 buildings) |
| Friesland farmland | 91-498 | yes 49-56, service 32 | 0 / 0 | 72 / 530 | 1.46 | 65/10/25/0 | large barns 375 m² median, 57% on `farmyard` |
| Achterhoek rural | 623 | yes 83, house 14 | 0 / 40 | 68 / 467 | – | 92/8/0/0 | barns 330 m², 3 buildings within 45 m (farmstead) |
| Limburg Heuvelland | 2.9k | yes 50, house 44 | 3 / 29 | 76 / 228 | 1.64 | 41/24/32/2 | courtyard farms (rectangularity 0.80) |
| Westland greenhouses | 3.7-10k | yes 46, house 41, shed 6, greenhouse 3 | 1 / 15 | 48 / 195 (p99 20k) | 1.5 | 24/9/60/7 | greenhouses median 12,600 m², on `farm` landuse 72% |
| Rotterdam port (Pernis) | 1.9k | yes 99 | 0 / 22 | 139 / 676 | 1.03 | – | 661 round tanks, 68% overlap |
| Rotterdam centre | 7.0k | yes 65, apt 21, house 6 | 5 / 5 | 85 / 334 | 1.82 | 3/1/17/80 | levels up to 50; row members 8.0 m wide (postwar) |
| Den Haag Schilderswijk | 19.4k | yes 32, apt 32, house 24, shed 9 | 7 / 0 | 54 / 188 | 1.80 | 1/1/23/74 | pre-war blocks, 5.4 m bays |
| Bijlmer area | 9.4k | house 46, shed 29, yes 14, apt 4 | 48 / 29 | 45 / 76 | 1.73 | 1/1/69/27 | apartments up to 20 levels |
| Veluwe forest | 33 | yes 85 | 0 / 0 | 51 / 489 | 1.5 | 85% detached | lodges, holiday parks, restaurants |

Typical sizes by raw tag or POI, over all urban places (area p10/p50/p90 in m²; aspect is the median):

| Tag / POI | n | Area p10/50/90 | Aspect | Touching | Levels p50 (when known) |
|---|---|---|---|---|---|
| house | 44.6k | 42 / 57 / 102 | 1.92 | 95% | 2 |
| yes | 42.9k | 5 / 15 / 143 | 1.57 | 72% | 2 |
| apartments | 19.2k | 56 / 95 / 242 | 1.97 | 97% | 5 |
| shed | 8.6k | 5 / 7 / 11 | 1.40 | 84% | 1 |
| POI shop / food | 3.7k | 50 / 125 / 1,000 | 2.1 | 93% | 5 (shops sit under homes) |
| industrial | 1.7k | 22 / 95 / 1,035 | 1.78 | 84% | 3 |
| houseboat | 694 | 43 / 83 / 130 | **3.80** | 14% | 1 |
| school (tag) | 155 | 366 / 951 / 2,417 | 1.52 | 42% | 3 |
| greenhouse | 122 | 1,819 / 12,589 / 32,396 | 1.56 | 57% | 1 |
| office | 119 | 92 / 483 / 3,774 | 1.68 | 61% | 4 |
| church | 83 | 198 / 712 / 1,712 | 1.63 | 71% | – |
| POI fuel | 30 | 88 / 267 / 850 | 1.70 | 47% | 1 |
| POI grocery | 248 | 53 / 199 / 2,765 | 1.93 | 89% | (supermarkets 1,000-2,800) |
| static_caravan | 84 | 44 / 69 / 123 | 2.31 | 7% | 1 |
| garage | 474 | 5 / 17 / 28 | 1.89 | 96% | 1 (garage boxes in rows) |

## 2. Typology

Colours are arcade-brightened versions of the `docs/ART_STYLE.md` palette. "Ridge ∥
street" means the ridge runs parallel to the street (eaves face the street). "Ridge ⊥"
means the gable end faces the street.

### 2a. Homes

| Type | Where | Footprint | Storeys | Roof and ridge | Materials and openings | Arcade look |
|---|---|---|---|---|---|---|
| **Grachtenpand** (canal house, 1600-1800) | Amsterdam ring, Leiden, Haarlem, Delft, Utrecht, Dordrecht, Den Bosch, Middelburg cores | 4.5-8 m wide, 12-25 m deep, aspect 2-4, party walls both sides, front on a canal or street | 4-6 (with height tag: h/3.3) | Steep gable **⊥ street**. The front is a decorative gable: stepped (trap), neck (hals), bell (klok), spout (tuit), or a straight cornice (lijst, 18th c.) that hides a ridge ∥ street or a flat roof | Dark red-brown or near-black brick (`#5e3a30`), white sandstone trim, white sash windows 2 per storey (3 on wide houses), hoisting beam at the top, a door up a stoop with steps, a basement door below | Narrow tall roof strips with a white gable silhouette on the street side. Vary the gable shape per house. Dark-green or black doors |
| **Pre-war city block** (1880-1940): portiek/boven-benedenwoning | Rings around every old centre (Schilderswijk, De Pijp, Utrecht Lombok, Rotterdam Noord) | Bays 5-7 m wide, 9-14 m deep, perimeter blocks (component > 12) | 3-4 | Ridge **∥ street**: a steep front slope with a flat top (mansard-like) or a gable with dormers. Amsterdam School (1915-30) has flat roofs and rounded corners | Orange-red or brown brick (`#a5523a`), white or cream frames, a shared portiek door (recess with 2-4 doors) every 2 bays, vertical rhythm of 2 windows per bay, balconies at the back | Long continuous roof with a straight ridge and dormer bumps. Corner bays are a shop with a cut corner |
| **Jaren-30 house** (1920-1940) | Middle-class suburbs: Den Haag Bomenbuurt, Utrecht Oog in Al, Haarlem, Hilversum | Semis or short rows, 6-8 m wide, 9-11 m deep, front garden 3-5 m | 2 + attic | Steep hip or gable **∥ street**, often a hip over the pair, dormers, a gable on the bay | Red-brown brick, orange or black glazed tiles, white frames, a bay window (erker) at the front, stained-glass top lights, green or cream doors with a canopy | Steep orange roof with a little front bay bump and a white frame pattern |
| **Postwar rijtjeshuis** (1950-1980) | Every town's ring, most of the national stock | Rows of 4-12, **5.1-6.5 m x 8-11 m**, front and back gardens, a shed at the back | 2 + attic | Gable **∥ street** (one ridge over the whole row), 40-50°. 1960s-70s rows can be flat-roofed | Yellow-beige or red brick (`#c49a6c` / `#9e4e3a`), anthracite or red concrete tiles, wide windows, panel strips, the door at one side of each bay (mirrored in pairs) | One long gable roof over the row, split by faint party lines. Identical bays. The model already has a `row` field |
| **Bloemkoolwijk** (1975-1990) | Houten, Zoetermeer, Almere Haven, Lelystad, Purmerend | Short staggered rows, L-shapes, woonerf courts, irregular angles | 2-3 | Steep, asymmetric gable or shed, ridge ⊥ in clusters, with dormers | Dark brown brick, brown wooden frames, anthracite tiles | Chunky dark roofs at mixed angles |
| **Twee-onder-een-kap** (semi) | Every era. Postwar suburbs, villages, Vinex | 2 houses of 7-9 m x 9-11 m, total 130-200 m², often a garage annex on the side | 2 + attic | One hip or gable over the pair, ridge **∥ street** | Like its era. Doors at the outer ends | Mirror the pair |
| **Vrijstaand / villa** | Het Gooi, Wassenaar, Brabant and Gelderland villages, rural ribbons | 80-200 m² (median 98-130), aspect 1.3-1.5 | 1.5-2 | Hip, or gable ∥ street. **Thatch (riet)** on rich villas and farm-style houses | Brick or white render, thatch `#8a7a4c` with a tile or ridge cap, shutters | Big roof, garden all round, a garage shed beside it |
| **Bungalow** | Postwar villages, holiday parks | 80-150 m², 1 storey | 1 | Flat or low hip | Render or brick | Flat roof with a skylight |
| **Vinex house** (1995-2015) | Leidsche Rijn, Vathorst, Ypenburg, Ijburg, Almere | Rows of 4-8 at **5.4-6.6 x 9-11 m**, plus semis and detached houses of about 100 m² | 2-3 | Mixed per ensemble: gable ∥, flat, shed (lessenaar), mansard, sometimes ridge ⊥ for "dijkhuis" styles | Each ensemble has one style: dark-red, anthracite or white-glazed brick, timber cladding, big windows, coloured doors | **One style per row, change at the next row**: roof kind, brick colour, door colour |
| **Portiekflat** (1950-1965) | Postwar districts (Kanaleneiland, Slotervaart, Zuidwijk) | Slabs 30-80 m x 10-12 m, aspect 3-7 | 3-4 (5) | Flat (or a low gable on the earliest ones) | Yellow or red brick, stairwell doors every 12-16 m with a vertical glass stair strip, balconies | Long flat roof with stair housings. Doors on a regular beat |
| **Galerijflat / slab** (1960-1975) | Bijlmer, Overvecht, Ommoord, every city edge | Slabs 60-250 m x 10-14 m, aspect 5-20 (may arrive split into segments) | 4-14 | Flat with lift and machine housings | Concrete panels in grey or beige, an open gallery on one long side (usually north), balconies on the other, a ground-floor storage plinth | Very long flat roof, gallery stripe, a stair or lift tower at the ends |
| **Modern apartment block / tower** | City centres, Zuidas, Rotterdam Kop van Zuid, stations | 400-2,000 m², compact (aspect < 2.5) | 6-50 | Flat | Glass, light brick, metal | Flat roof with an HVAC pattern. Tall towers need the facade strip capped (ART_STYLE §2) |
| **Wederopbouw** (1950-1965 rebuilt centres) | Rotterdam centre, Nijmegen, Middelburg, Arnhem parts | Large rectangular blocks, bays 7-10 m | 4-6 | Flat | Brick plus concrete frames, shops under homes (Lijnbaan) | Flat, orderly, shopfronts at street level |
| **Houseboat (woonboot)** | Amsterdam canals, Utrecht, rivers | 40-130 m², aspect about 3.8, in water | 1 | Flat or low curved | Timber in bright colours, plants | Boat hull edge, flat roof, deck |

### 2b. Shops, services and civic

| Type | Where | Footprint | Storeys | Roof | Look |
|---|---|---|---|---|---|
| **Shop with homes above** | Old centres, ribbon high streets, 1960s shopping strips | Like the house or bay type it sits in | 2-5 | As its host type | Ground floor all glass with a coloured sign band (shopfront opening). Homes above keep the host rhythm |
| **Supermarket** | Neighbourhood centres, edge-of-town retail | 1,000-3,000 m², compact, often under apartments in towns | 1 (6-7 m) | Flat | Glass entrance on the parking side, a brand-coloured band (use generic colours, no real brands), trolleys |
| **Retail box / garden centre / DIY** | Woonboulevards, edge of town | 2,000-15,000 m² | 1 | Flat, or a glass greenhouse section | Sheet cladding with a big sign band |
| **Petrol station** | Main roads and motorway services | Canopy 150-600 m² (often `roof`) plus a shop of 50-200 m² | 1 | Flat canopy, flat shop | Bright canopy band with pumps under it. The canopy is open: walk under it |
| **School** | In every neighbourhood, next to pitches or playgrounds | 500-4,000 m², L, U or comb shapes | 1-2 (pre-war 2-3) | Postwar flat. Pre-war a big hip with tall windows | Long window bands, a schoolyard with a fence, bike racks |
| **Church** | Village centres (the tower dominates), city centres, 19th-c. Catholic south | 200-1,700 m², nave aspect 2-3, often a cross plan, tower 6-12 m square at one end. Old naves run east-west | Nave 10-20 m. The tower is the landmark | Steep gable along the nave (slate `#4a5160` or red tile), spire or saddle-roof tower | Brick, tall pointed windows, west door. Draw the tower roof clearly |
| **Mosque** | Cities | 300-1,500 m² | 2 | Flat with a dome | White or sand render, a minaret |
| **Hospital** | City edges | 5,000-50,000 m², wings | 3-10 | Flat, with a helipad on the main block | White or beige, many windows, an ambulance bay |
| **Town hall / civic** | Centre square | 300-2,000 m² | 2-4 | Old: steep hip with a little tower. New: flat | Stone trim and a flag |
| **Police station** | Towns, near the centre | 300-2,000 m² | 2-4 | Flat | Blue band, closed fence, car park |
| **Fire station** | Towns | 300-1,500 m² | 1-2 | Flat, and a drill tower on older ones | 2-4 big red or white doors on the street side |
| **Train station** | On rail lines, in town centres | Building 300-3,000 m² plus platform canopies (long, thin, often `roof`) | 1-3 | Old: hipped eclectic. New: glass vault or flat | Clock, bike parking, platform canopies |
| **Office** | Business parks by motorways, stations, centres | 500-4,000 m², compact | 3-10 | Flat | Glass band windows. Ground floor has an entrance lobby |

### 2c. Rural, industrial and odd

| Type | Where | Footprint | Height | Roof | Look |
|---|---|---|---|---|---|
| **Stolpboerderij** | Noord-Holland north of the IJ: Beemster, Schermer, West-Friesland | **Square 14-25 m**, 200-600 m², aspect < 1.25 | 1 storey + huge roof | **Pyramid** (hip to a point or short ridge). Thatch with a tile band at the eaves, or full tile | A house front in a decorated "pronkgevel", white frames, green shutters. A big pyramid roof is the single clue |
| **Kop-hals-romp** | Friesland, Groningen | House at the front (kop) plus a neck plus a huge barn (romp). Total 500-1,500 m², T or L, aspect 2.5-4 | 1-2 storeys plus a very high barn roof | The barn has a huge hip or half-hip **along its long axis**. The house has a gable ⊥ to the barn | Red-brown brick, red or blue-black glazed tiles, big barn doors at the far end | The barn roof is twice the house's. Draw wings separately |
| **Langgevel / hallehuis** (long farm) | Brabant (langgevel), Gelderland, Overijssel, Drenthe, Achterhoek (hallehuis) | 150-500 m², aspect 2-3, house end towards the road | 1 plus attic | Gable or half-hip **along the long axis**. Thatch or red tile | Barn door on the far gable. Shutters in red/white or green/white (Achterhoek) | Long, low, big roof |
| **Courtyard farm (carré)** | Limburg Heuvelland | Closed square ring 25-40 m (rectangularity < 0.8, hole or U) | 2 | Gables around the courtyard | Marlstone, white render, a gate arch | Ring of wings |
| **Modern cow shed (ligboxenstal)** | All dairy country | 1,000-4,000 m², 25-40 m wide, aspect 1.5-3 | Eaves 4 m | Low-pitch gable with a ridge vent, fibre cement in grey or green | Open sides with curtains, a feed path | Big pale roof with a ridge-vent stripe |
| **Pig / poultry shed** | Gelderse Vallei, Peel (Brabant/Limburg) | 12-20 m x 50-120 m, **aspect 4-8** | 3-4 m | Low gable, fans along the ridge | Grey sheet | Long grey bars side by side |
| **Barn, shed, hay barn** | Around every farmstead | 50-400 m² | 4-7 m | Gable or a shed lean-to | Black-tarred wood, sheet metal | Dark planks |
| **Greenhouse (kas)** | Westland, Oostland, Aalsmeer, Venlo, Emsland edge | **2,000-100,000 m²**, rect > 0.9 | 5-7 m | Venlo type: many small parallel ridges about 4 m apart along the long axis, all glass | Glass, a white steel grid, crop rows inside | Glass grid with a light sheen, rows of crops inside. Never cut into rooms |
| **Industrial hall / distribution centre** | Bedrijventerrein by motorways, ports. XXL DCs at Tilburg, Venlo, Moerdijk | 500-100,000 m², rect > 0.9 | 8-14 m | Flat. Old factories use sawtooth (shed rows) | Sandwich panels in grey, blue, white or green. Loading docks along one long side, an office block at a corner | Huge flat roof with skylight rows and dock doors |
| **Storage tank / silo** | Ports (Pernis, Botlek, Europoort), feed mills | Round, 10-80 m diameter | 10-25 m | Round, flat or dome | White or silver | Round with a ring shadow. Not enterable |
| **Windmill** | Kinderdijk, Zaanse Schans, every old village edge | Octagon or round, 60-200 m², isolated | 15-30 m | Cap and sails | Thatch body or brick tower, white sails | Landmark. Draw the sails cross over the top |
| **Garage boxes** | Behind postwar blocks | Rows of 3 x 6 m units (10-20) | 2.5 m | Flat | Coloured metal doors | Repeated doors |
| **Garden shed** | Behind every terrace | 4-15 m², touching fences | 2.2 m | Flat or shed | Wood | Tiny dark roof. Not a house |
| **Holiday chalet / static caravan** | Veluwe, coast, lakes (vakantieparken) | 40-120 m², aspect 2-3, isolated, in forest | 1 | Low gable or flat | Wood | Cabin |
| **Bunker** | Coast (Atlantikwall), Nieuwe Hollandse Waterlinie | 20-200 m² | 2-3 m | Flat, earth-covered | Concrete | Grey block |

## 3. Detection rules

### 3a. Pre-pass (per chunk, before typing)

1. **Dedupe.** If footprint A's centroid lies inside footprint B and `area(B) >= 0.5 x
   area(A)`, keep the larger one (or the one with levels or height) and drop the
   other.
2. **Size class** from area `A` in m²:
   - `tiny` under 15
   - `small` 15-40
   - `house` 40-200
   - `mid` 200-1,000
   - `large` 1,000-5,000
   - `huge` 5,000 and up
3. **Shape.** Work these out in the dominant-axis frame:
   - `W` (short side) and `L` (long side)
   - `aspect = L / W`
   - `rect = A / (W x L)`, where a rectangle is about 1, an L or T shape 0.6-0.85,
     and a circle 0.785
   - `nv`, the number of vertices
   - **round** when `nv >= 10 && 0.72 < rect < 0.83 && aspect < 1.12`
4. **Party walls.** Two footprints are neighbours when at least 2 m of boundary (or
   at least 10% of the perimeter) lies within 0.7 m of the other. **Only footprints
   of 25 m² or more count** (leave out sheds and small annexes).
5. **Rows vs blocks.** Rows come from the party-wall graph:
   - Chain neighbours whose dominant axes differ by less than 12°, whose depth `L`
     differs by less than 30%, and whose door side faces the same street (use
     `findDoor`).
   - A corner, meaning an axis change of more than 30° or a member touching three
     or more others, ends the row.
   - A component with more than 12 members, or a closed ring, is a **perimeter
     block**.
   - `row` id = the sorted ids of the chain's ends. A row has 3+ members, a pair
     has 2.
6. **Context per building:**
   - `poi`: the class of any POI inside the footprint (use the first one). Keep the
     form class as `cls` and pass the POI as `use`.
   - `lu`: the raw landuse under the centroid. Keep `greenhouse_horticulture`,
     `farmyard`, `industrial`, `port`, `retail`, `religious` and `education` raw,
     not as the game surface class.
   - `rural`: no `residential` landuse **or** fewer than 15 buildings of 25 m² or
     more within 100 m.
   - `cluster45`: the number of buildings within 45 m. A farmstead is 1-7 around a
     barn.
   - `inWater`: the centroid is in a water area.
   - `nearRail`: within 40 m of a `rail` line.
   - `nearMajor`: within 30 m of a primary, secondary or trunk road.
7. **Old-core score** (no year data exists). Count +1 for each of these:
   - (a) in a perimeter block, and the median bay width there is under 8 m
   - (b) the axes of neighbouring rows deviate by more than 5° from each other (not
     planned on a grid)
   - (c) more than 300 POIs per km² within 150 m
   - (d) within `clamp(60 x sqrt(pop/1000), 250, 1500)` m of a manifest city's
     point (cities of 10k+ only)
   - (e) a canal or water within 25 m of the front

   **Old core is a score of 3 or more.** Rotterdam centre fails (a): its bays are
   8.0 m against 5.4-6.1 m elsewhere. Flag it as **wederopbouw** instead: a
   perimeter block with bays of 7-12 m and `pop > 200k`, or levels 4-6 with
   compact rectangles.

### 3b. Typing (first match wins)

```
Storeys: levels tag > round((height - roofH)/3) (pitched roofH ~ 0.4 x span) > the type default below.

round                               -> A>=150 && (lu industrial|port || nearby round>=3) ? TANK
                                       : 50<=A<=250 && cluster45<=2 ? WINDMILL : SILO (A<150, rural) / other
raw houseboat || (inWater && aspect>2.5 && A<200)                           -> HOUSEBOAT
raw static_caravan|cabin || (forest/no-lu && A 30-120 && aspect>1.8 && no party wall && >=5 similar within 60 m)
                                                                             -> CHALET
raw greenhouse || (A>=1500 && rect>0.9 && lu greenhouse_horticulture|farm(raw greenhouse_horticulture))
            || (A>=4000 && rect>0.92 && rural && neighbours of the same kind)  -> GREENHOUSE (eaves 6 m, glass)
raw church|chapel|cathedral|religious|mosque || lu religious                 -> CHURCH (mosque if raw mosque)
raw roof || (A 120-700 && poi fuel)                                          -> CANOPY (open roof; poi fuel -> PETROL)
poi fuel && A<250                                                            -> PETROL SHOP
raw train_station|transportation || (nearRail && aspect>6 && A>150)          -> STATION / PLATFORM CANOPY
raw hospital || poi medical && A>=3000                                       -> HOSPITAL (3-6 st., flat)
poi police / raw police                                                      -> POLICE (2-3 st., flat)
poi fire_station / raw fire_station                                          -> FIRE STATION (big doors, street side)
raw school|college|university|kindergarten|education || (poi school && A>=300) || (lu education && A>=200)
                                                                             -> SCHOOL (1-2 st., flat; pre-war in an old core -> hip, 3)
poi grocery && A>=700                                                        -> SUPERMARKET (1 st., flat)
                                                                                (if a house/apartments form tag, or a party wall in a block -> apartments above)
(poi hardware|outdoor|shop && A>=1500 && !inBlock)                            -> RETAIL BOX
raw industrial|warehouse|factory|manufacture|commercial(A>=800) || (A>=800 && rect>0.85 && lu industrial|port|commercial)
                                                                             -> INDUSTRIAL HALL (A>=10k -> DC; aspect>4 && W<=20 && rural -> ANIMAL SHED)
raw office || (A>=500 && levels>=4 && !residential tag)                      -> OFFICE (flat)
rural farm block (rural && no party wall && (lu farmyard || cluster45 1..7)):
   A>=1000 && aspect 1.5..3.5                                                -> COW SHED (low gable along L)
   A>=500  && aspect>=4 && W<=22                                             -> PIG/POULTRY SHED
   A 200..700 && aspect<1.25 && rect>0.85 && NH (lon<5.3 && lat>52.45)       -> STOLP (pyramid)
   A 450..1600 && aspect 2..4.5 && (rect<0.9 || FR/GR lat>52.85)              -> KOP-HALS-ROMP (barn wing hip along L, house gable ⊥)
   A 150..500 && aspect 1.8..3.2                                             -> LANGHUIS / LANGGEVEL (gable or half-hip along L)
   A 600..2500 && rect<0.75 && lat<51.0                                      -> CARRÉ FARM (ring of wings)
   A 40..200                                                                 -> FARMHOUSE (detached house rule) ; A<120 near a barn -> BARN/SHED
A<15 (tiny)                                                                   -> GARDEN SHED (flat or shed roof, 2.2 m, not enterable)
A 15..40 && (raw garage|garages || >=3 similar in a row of party walls)       -> GARAGE BOX ROW (flat)
A 15..40                                                                      -> SHED / ANNEX (shed roof, falls away from the main house)
raw apartments|residential|dormitory|hotel, or yes/house with A>=200 && party walls in a block:
   aspect>=4 && L>=50                                                        -> SLAB: levels>=5 or L>=80 -> GALERIJFLAT (flat, gallery on the north side)
                                                                                else PORTIEKFLAT (3-4 st., flat, stair doors every 14 m)
   A>=400 && aspect<2.5 && (levels>=7 || height>=21)                         -> TOWER (flat)
   oldCore && W<=8.5 && aspect>=1.8                                          -> GRACHTENPAND / old townhouse
   wederopbouw                                                               -> WEDEROPBOUW BLOCK (flat, 4-5 st.)
   in a perimeter block                                                      -> PRE-WAR BLOCK (3-4 st., ridge ∥ street, mansard front)
   else                                                                      -> MODERN APARTMENTS (4-5 st., flat)
house-size (40..200) yes/house/terrace/detached/semidetached:
   oldCore && in a block && W<=8.5                                           -> GRACHTENPAND (4 st. in a city of 50k+, else 2-3; gable ⊥ street)
   row (>=3, not a block)                                                    -> TERRACE HOUSE (2 st. + attic, one gable ∥ street over the row;
                                                                                 aspect<1.6 && W>=6.5 -> Vinex style; ensemble = row id)
   in a perimeter block (not old core)                                       -> PRE-WAR BLOCK BAY (3 st., ridge ∥ street)
   pair (2)                                                                  -> TWEE-ONDER-EEN-KAP (hip over the pair, ridge ∥ street)
   detached && A<=110 && (raw bungalow || levels==1)                         -> BUNGALOW (flat or low hip)
   detached                                                                  -> VRIJSTAAND (hip if aspect<1.4 else gable ∥ long side;
                                                                                 thatch 25% when rural && A>=120)
poi shop|food_service|pharmacy|grocery|... on any home form                   -> keep the form, set ground floor = SHOPFRONT
fallback A>=200                                                               -> GENERIC COMMERCIAL (flat, 1-2 st.)
fallback                                                                      -> HOUSE rule above
```

### 3c. Roof and ridge rules the model can apply after typing

- **Ridge direction.** On a row, semi or block, the ridge runs ∥ the street and ∥ the
  row axis. The exception is GRACHTENPAND (⊥ street). For a detached or farm
  building, the ridge runs along the long side `L`. When `aspect < 1.25`, use a
  hip, or a pyramid for STOLP.
- **One roof per row.** Terrace members share eaves height and ridge height, so draw
  the ridge continuous across the party walls. Vinex ensembles vary roof kind,
  brick and door colour per row id (hash it), never per house.
- **Flat-roof rule.** Use a flat roof for every type above 1,000 m² except CHURCH,
  COW SHED and GREENHOUSE. Also use flat for slabs, towers, wederopbouw, offices,
  supermarkets, schools (postwar), garage boxes and canopies. Mansard goes on the
  street side of PRE-WAR BLOCK bays and on 15% of Vinex rows. Shed (lessenaar) goes
  on annexes of 15-40 m², which slope away from the house they touch, and on 15%
  of Vinex rows.
- **Wings.** When `rect < 0.85`, decompose into wings (the existing `decompose`).
  The main wing takes the type's roof. Wings under 40 m² stuck on a house get flat
  or shed roofs (aanbouw). Wings of farms (KOP-HALS-ROMP) get their own gables.
- **Heights.** Storey 3 m (shops 4 m on the ground floor, halls 8-12 m eaves,
  greenhouses 6 m, sheds 2.2 m). Roof rise is about 0.45 x span for houses and
  farms (thatch 0.6), 0.15 for halls and cow sheds, and 0 for flat roofs.

### 3d. Openings rhythm (per facade along the street)

| Type | Door | Windows per storey |
|---|---|---|
| Terrace / Vinex | 1 per bay, at the side, mirrored in pairs | Ground floor 1 wide; upper floors 2 |
| Grachtenpand | 1, centred or at the side, at the top of steps | 2-3 tall per storey, plus a hoist door at the top |
| Pre-war block | 1 portiek per 2 bays | 2 per bay per storey |
| Portiek / galerij flat | Stair door every 12-16 m | A window every 3-3.6 m on every storey |
| Shop-with-homes | Shopfront for the full bay width; side door to upstairs | Host rhythm |
| Supermarket / retail | A glass entrance pair on the parking side | Few or none (blank walls) |
| Hall / DC | Dock doors every 4 m on one long side, an office entrance at a corner | A clerestory band |
| Farm | Barn doors on the gable far from the road; house door on the road | 2-4 small windows with shutters |
| School | 1-2 entrances | Continuous band |

## 4. Data gaps and cheap fixes (suggestions, not done)

- `src/data/osm.ts BUILDING`: add `houseboat`, `static_caravan`, `cabin`, `bunker`,
  `storage_tank`, `silo`, `boathouse` and `allotment_house`. Map `roof` to a
  `canopy` class, not `shed`.
- Keep the raw `building=` value and the raw landuse on `GeoArea`, so the model can
  tell `yes` from `house`. Keep `greenhouse_horticulture`, `farmyard` and
  `religious` separate from `farm` and `commercial`.
- `levelsOf()`: for `height` without levels, subtract a roof allowance.
- The bake drops `amenity=place_of_worship`, churches, train stations, town halls
  and windmill POIs from Overture places (see `POI` in `tools/geobake/bake_detail.py`).
  Adding "church|place_of_worship", "train_station", "town_hall" and "windmill"
  would make the rare landmark types reliable instead of guessed.
- Overture has no construction year. The old-core and era signals are proxies, so
  tune them on screenshots of Amsterdam, Utrecht, Rotterdam and Den Haag.

Sampler scripts (throwaway):
`/tmp/claude-0/-home-claude-pocketpocalypse/01d21528-e433-5342-98d4-c77d105058fb/scratchpad/research/sample.ts`
and `global.ts`, bundled with esbuild and run with node.
