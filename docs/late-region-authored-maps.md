# Galar, Hisui, and Paldea authored map record

These maps are original, simplified 3D reconstructions for Choketmon. Coordinates, road widths, terrain surfaces, collision envelopes, encounter balance, and campaign teams are authored game data. They are not extracted maps or claims of cartridge-exact geometry.

Public region selection remains disabled until model distribution, licensing, texture, visual review, browser traversal, encounters, and save recovery all pass the release gate. The atlas definitions remain loadable for validation and future save compatibility.

## Geography and progression sources

### Galar

- The official [Galar region overview](https://swordshield.pokemon.com/en-us/story/the-galar-region/) establishes the region's towns, cities, plains, stadium Gyms, and Pokémon League goal.
- The official [Wild Area overview](https://swordshield.pokemon.com/en-us/gameplay/wild-area/) establishes that the Wild Area connects multiple towns and cities and that encounters vary by location.
- The official [Galar tour brochure and map](https://assets.pokemon.com/assets/cms2/pdf/video-game/sword-shield/Galar_Tour_Brochure_US.pdf) is the visual reference for the south-to-north regional layout.
- The reconstructed graph follows Postwick–Wedgehurst–Wild Area–Motostoke, then the Gym Challenge towns and Wyndon. Wild Area nodes are connected explicitly rather than represented as one generic road.
- Eight Gym stages and five Champion Cup battles are authored balance using the Sword branch where the versions differ. Teams use only models currently present in the public runtime.

### Hisui

- The official [Hisui story overview](https://legends.arceus.pokemon.com/en-us/story/) establishes Jubilife Village as the expedition base, Mount Coronet at the center, distinct surrounding ecosystems, noble Pokémon, and the temple at the summit.
- The reconstructed graph uses Jubilife Village as a hub for Obsidian Fieldlands, Crimson Mirelands, Cobalt Coastlands, Coronet Highlands, and Alabaster Icelands, with the Temple of Sinnoh reached from the mountain and icefield branches.
- Legends: Arceus has no regional Gym League. The eight badges in the shared campaign schema are labeled survey certificates and noble/area trials. Its five final battles are labeled authored Survey Corps trials.
- Hisuian-form model audit is still separate from base National Dex geometry. Hisui therefore stays unavailable even where a base-species model exists.

### Paldea

- Nintendo's official [Pokémon Scarlet overview](https://www.nintendo.com/us/store/products/pokemon-scarlet-114549/) establishes Paldea as an open world of lakes, peaks, wastelands, towns and cities, with freely ordered Victory Road Gyms and Champion Rank.
- The Pokémon Company's [region-map article](https://www.pokemon.com/us/news/adventure-from-kanto-to-paldea-with-the-pokemon-center-s-region-map-posters) anchors Mesagoza, Area Zero, Glaseado Mountain, and Casseroya Lake on the regional journey.
- The reconstructed graph branches west, east, and south from Mesagoza, reconnects northern routes around Glaseado Mountain, and gives Area Zero two late-game approaches. Required-badge values are Choketmon balance gates; they do not claim an original fixed route order.
- Eight Gym stages and five League battles are authored balance. Teams use only models currently present in the public runtime.

## Encounter provenance

- Galar source pools come from the pinned [PokeAPI data repository](https://github.com/PokeAPI/pokeapi) revision `8fe210b21c9abbe73de93670f3d5a346c80a3625`, BSD-3-Clause. The generator selected Sword because it had the greatest unique-species coverage among walk/surf rows (102 pools, 115 species).
- The same pinned PokeAPI data contains no Legends: Arceus version encounter table and zero Scarlet/Violet walk/surf rows.
- Hisui and Paldea therefore use explicit `origin: supplemental` habitat anchors. They supply runnable biome and level balance without presenting those rows as original encounters. Native species missing from a base anchor remain explicit rare supplemental rules.
- Rendering and map sampling do not consume simulation randomness.

## Local verification

- `tests/late-region-authoring.test.ts` samples every connection at 21 points, verifies collision-free traversal and town-building collision, checks graph reachability, validates source versus supplemental encounter labels, covers every late-generation native species through a source or explicit supplement, and round-trips all three campaign records through save validation.
- `tests/ui/dex-map-navigation.spec.ts` verifies desktop and mobile map controls, compass state, clickable traversable points, and actual player-coordinate movement on a publicly enabled region. Galar, Hisui, and Paldea are intentionally absent from that public selector while their release gates remain closed.
