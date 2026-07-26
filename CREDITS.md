# Asset Credits

Most 3D models in `public/models/` were created and distributed by
**Kenney** — [www.kenney.nl](https://www.kenney.nl) — under the
**Creative Commons Zero (CC0)** license:
http://creativecommons.org/publicdomain/zero/1.0/

Models were taken from the following Kenney asset packs:

| Pack | Used for |
| --- | --- |
| Tower Defense Kit (2.1) | towers, weapons, ammo, ground tiles, spawn pads, crystals |
| Mini Characters (1.x) | the four playable classes, mage staff (cane) |
| Graveyard Kit (5.0) | skeleton / zombie / ghost / vampire / keeper enemies, obstacles, decor, sanctuary stonework (altar, pillars, obelisk, bowl), boss props (gravestone, grave mound, carved pumpkin, shovel, coffin) |
| Mini Dungeon (1.x) | orc enemy, Berserker character, sword, shield, great shield, barrel obstacle, gold coins, pet-shop stall (wood structure, banners, chest) |
| Mini Arena (1.x) | Tanker character, sanctuary statue and columns, spear, great sword, weapon-smith hut (walls, columns, banner, weapon rack, trophy, block) |
| Survival Kit (2.0) | Berserker battle axe, great axe, war hammer |
| Mini Forest (1.0) | Archer character, bow |
| Cube Pets (1.0) | the 13 companion pets (dog, cat, pig, crab, bunny, fox, lion, tiger, giraffe, elephant, hog, monkey, panda) |

CC0 means the content can be used for personal, educational and commercial
purposes. Crediting Kenney is not required, but very much deserved —
consider donating at https://www.kenney.nl/donate.

The bat, spider and dragon enemies are by **Quaternius** —
[quaternius.com](https://quaternius.com) — also released under **CC0**.
Unlike the Kenney enemies (rigid parts moved by node transforms) these
are skinned meshes carrying 23–39 bones each, so they cost noticeably
more CPU per instance — worth remembering before flooding a wave with
them.

They ship as raw `FBX2glTF` output, which is roughly twice the size it
needs to be: a second UV set with no texture to sample it, animation
baked at one keyframe per frame, and unquantized float32 throughout.
The copies in `public/models/enemies/` were reprocessed with
[glTF Transform](https://gltf-transform.dev) —
`prune → dedup → resample → weld → join → quantize` — which cuts them
~45% (bat 226→125 KB, dragon 263→148 KB, spider 439→245 KB) without
touching the geometry. Quantization uses `KHR_mesh_quantization`, which
three.js reads natively, so no decoder is needed. Their animation clips
were also renamed to the names the renderer looks up (`idle`, `walk`,
`die`, `attack-melee-right`, …); `idle`/`sprint` are aliases that share
the source clip's accessors, so the extra names cost no bytes.

UI icons are from [Lucide](https://lucide.dev) (ISC license), inlined in
`src/icons.js`. The class-selector glyphs (axe / shield / archer / wizard
hat) are from [game-icons.net](https://game-icons.net) by **Lorc** and
**Sbed**, licensed **CC BY 3.0**. Class/tower thumbnails in `public/img/`
are the preview renders that ship with the Kenney packs above (CC0).

The ornate panel/button/slot frames and divider flourishes in
`src/assets/ui/` are cleaned 9-slice crops of the **Fantasy UI Borders**
pack by **Kenney** ([www.kenney.nl](https://www.kenney.nl)), **CC0**.

## Fonts

The interface is set in **Wotfard** by
[Atipo Foundry](https://www.atipofoundry.com), offered under their
pay-what-you-want licence. The game logo uses **Ferrum** by
**Marco Kaschny** (**CC0**). Both are self-hosted as woff2 in
`src/assets/fonts/`.

## Libraries

- [three.js](https://github.com/mrdoob/three.js) — 3D rendering
- [miniplex](https://github.com/hmans/miniplex) — entity component system
- [yuka](https://github.com/Mugen87/yuka) — enemy steering / game AI
- [trystero](https://github.com/dmotz/trystero) — serverless WebRTC co-op multiplayer
- [tiks](https://github.com/rexa-developer/tiks) — procedural UI sounds
