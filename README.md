# Drawings (Kresby) for Kingdoms Connected

Player drawings for **Kingdoms Connected** (KCDC, the Kingdom Come: Deliverance II multiplayer platform): notice
boards and easels in the world, inks and mixed colours, drawings carried in the bag, read up close with the camera.
Finished drawings appear in the world as lit textures with shadows. Other resources build on it through an API
(boards, sheets, drawing sessions without materials, baking textures), for example the
[School](https://github.com/gingygames/kcdc-skola).

## Build and install

```
cd kresby/kcdc
npm ci
npm test                                                   # builds dist/kresby, runs the tests
node tools/build.mjs --out <server>/resources/kresby
```

Settings: F10 → Settings → Drawings (with `sprava` from [gingy-kcdc](https://github.com/gingygames/gingy-kcdc)), or
`resources/kresby/kresby_config.js`. The KCDC module is in `kresby/kcdc`; `kresby/server/kresby_png.lua` is the
KCD:MP codec, used only by a compatibility test.

## Documentation

- [kresby/kcdc/README.md](kresby/kcdc/README.md): module description, controls, settings (Czech).
- [kresby/kcdc/AGENTS.md](kresby/kcdc/AGENTS.md): API for other resources, custom UI (`setUi`), architecture.

## Source

This repository is generated from the monorepo [gingygames/gingy-kcdc](https://github.com/gingygames/gingy-kcdc)
(`kresby/kcdc`) together with the shared code it compiles in (same folder layout). Details in [ZDROJ.md](ZDROJ.md).
Report issues here; changes are made in gingy-kcdc and mirrored.
