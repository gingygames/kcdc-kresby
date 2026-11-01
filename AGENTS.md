# Guidelines for AI agents working in this repository

You are in **kcdc-kresby**, the Drawings resource for Kingdoms Connected (KCDC, Kingdom Come: Deliverance II
multiplayer). Read this file first, then [kresby/kcdc/AGENTS.md](kresby/kcdc/AGENTS.md) (integration points, framework
mapping, world textures, known KCDC limits; Czech) and [kresby/kcdc/README.md](kresby/kcdc/README.md). Code
identifiers and comments are Czech.

## This repository is a mirror

- Generated from the monorepo [gingygames/gingy-kcdc](https://github.com/gingygames/gingy-kcdc) by
  `tools/zrcadlo.mjs` (commit in [ZDROJ.md](ZDROJ.md)). Changes made here get overwritten by the next mirror.
- **Adapting to a server/framework:** use `kresby_config.js` (keys in `src/server/config.ts` `DEFAULTS`), the `most`
  bridge, and the client export `setUi` for a custom canvas/viewer, in *your own* resource or config.
- **Changing drawings itself:** change gingy-kcdc (`kresby/kcdc/`), run its tests, regenerate the mirror. Pull
  requests here are welcome as proposals and get ported by hand.
- `most/`, `sprava/`, `ui-kit/` and `kresby/server/kresby_png.lua` are **shared code copied from the monorepo**. Do
  not edit them here. The Lua file is the KCD:MP codec, used only by a compatibility test.
- Other resources depend on the drawings API (`src/server/api.ts`: `boardCreate`, `boardDraw`, `boardPut`,
  `drawingPrepare`, `boardShow` …), for example [kcdc-skola](https://github.com/gingygames/kcdc-skola). Treat it as a
  public API: extend it, don't break it, and keep `test/api.test.ts` green.

## Commands

```
cd kresby/kcdc
npm ci
npm test            # typecheck + build + tests (the codec test needs Python 3 with `pip install lupa`)
node tools/build.mjs --out <server>/resources/kresby
```

## Rules

1. Everything framework-specific goes through `src/server/most.ts`; do not call a framework directly elsewhere.
2. No dependency on `sprava` in the manifest (it pulls panels via `spravaPanels`); dependency cycles crash KCDC.
3. The resource must be named `kresby` (page URLs and storage keys use the name).
4. No global keys: menus via commands and native action hints.
5. World textures are streamed asset packages `kresby-obrazy-<n>`; on a foreign server set
   `KRESBY_CONFIG.svet.reload` so new packages get started (see `kresby/kcdc/AGENTS.md`, section 2b).
6. `npm test` passes before you finish; list in-game behaviour you could not verify (the tests use a fake KCDC).
