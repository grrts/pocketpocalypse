# Design notes

Decisions that shape the code beyond this proof of concept. None of this is
built yet unless it says so; it is here so today's code doesn't paint the
game into a corner.

## A harsh world

The game is meant to be harsh. You lose your gear quickly, and that includes
gear you paid for: there is no insurance, no protected slot and no
soulbound item. Everything you carry stays on your body when you die
(already true: `playerCorpses` in the save) and anyone who gets there first
can take it.

## Guns only enter the world by purchase

Guns and ammunition never spawn as world loot. They come into the world only
when someone buys them, and from then on they are ordinary items: a free
player can kill the carrier with a knife or a bat and take the gun off the
body. Paying adds firepower, and therefore violence, to the world; it does not
make anyone safe.

What the item and loot code needs for this:

- An origin on every item stack (`world` or `purchased`, plus who bought it
  and when) so purchases can be audited and balanced. It travels with the
  stack through containers, corpses and trades.
- Loot tables without firearms or ammo. The PoC still rolls pistols and
  rifles in police, army and crate tables (`src/game/items.ts`) so the gun
  code can be tested without a shop; drop those entries when purchases exist.
- The death drop working for every item type, purchased ones included. It
  already does: the body keeps the whole inventory.
- A server that owns item creation once multiplayer arrives, so a purchase is
  the only path that mints a gun.

## Vehicles: cars, boats, trains, planes

Vehicles will be drivable, and players will be able to get boats, trains and
maybe planes working.

- Vehicles are persistent entities, not scenery. Each has a stable id derived
  from where it was generated (like containers today), a type, position,
  heading, fuel, condition, its own inventory and who is in it. Moving one
  writes it to the save so it is where you left it.
- The abandoned cars the world already places are the first candidates: the
  same record gains fuel, battery and damage fields.
- Movement uses the networks we already bake: roads for cars, water areas and
  waterways for boats, rail lines for trains (they follow the track like a
  path), and open ground or runways for planes to take off and land. The
  bundles keep line geometry and tags for all of these, so a routing graph
  can be built from the same data.
- Faster travel means chunks have to load ahead of the player. The chunk
  manager already takes a list of focus points; a vehicle adds a point ahead
  of it along its velocity and widens the radius with speed.

## Camera follows altitude

A plane flies high, so the play camera must be able to pull far out and keep
playing there, not only during the intro zoom from space.

- In-game zoom is driven by the player's altitude or vehicle: on foot it is
  street level (`defaultPlayZoom`), in a car a bit higher, in a plane it
  follows altitude up to the regional levels.
- The levels are the same ones the intro flight uses: the overview tiles for
  country and region scale and the chunk renderer for streets, crossfading
  between them. Nothing new is needed for the look, only for keeping the
  simulation running while zoomed out.
- Gameplay at altitude works at overview resolution: no per-chunk detail is
  generated for the ground far below, and zombies and loot only load near
  where the plane lands.
