# Frontend source and local changes

This directory vendors the editable source of [MarSeventh/Sanyue-ImgHub](https://github.com/MarSeventh/Sanyue-ImgHub), version 2.7.6, at commit [`8849d89178aec7e8b1b312d1475c0d05ced7bbd7`](https://github.com/MarSeventh/Sanyue-ImgHub/commit/8849d89178aec7e8b1b312d1475c0d05ced7bbd7) (2026-09-11, “fix: preserve failed uploads for manual retry”). The original MIT license and copyright notice are preserved in `LICENSE`.

Source archive: <https://codeload.github.com/MarSeventh/Sanyue-ImgHub/tar.gz/8849d89178aec7e8b1b312d1475c0d05ced7bbd7>.

This source commit corresponds to the frontend update in backend commit `ce481fd84940881dfe638cad9978e20290a58d2d`. Before the first local rebuild, all 22 distinct original `src/**/*.js` files embedded in the existing frontend source maps exactly matched this source after newline normalization, including the router, store, main entry, authenticated fetch helper, icon registry, locale entry and upload/dashboard utilities. Vue source maps contain compiled templates and transformed scripts, so this check does not claim byte-for-byte equivalence of all build output.

## Build and test

From this directory, using Node.js 22 and npm 10:

```sh
npm ci
npm test
npm run build
```

`vue.config.js` writes the complete production build directly to `../frontend-dist`. It replaces that generated directory, including content-hashed JavaScript/CSS, source maps and gzip assets. Commit the editable source and generated output together; do not manually modify generated bundles. The lockfile pins build and test dependencies. No production service or cloud account is needed to build or run the component tests.

For local development, set `VUE_APP_BACKEND_URL=http://127.0.0.1:8080` in a local `.env.development` file and run `npm run serve`. This variable targets a local development backend. Local environment files and `node_modules` are ignored.

## Local customization

- `src/components/config/SysCogRetention.vue`: native scheduled-cleanup settings, preview and explicit confirmation, active progress and run history.
- `src/components/config/SysConfigTabs.vue` and `src/views/SystemConfig.vue`: `/systemConfig#retention` navigation.
- `src/locales/zh-CN.json` and `src/locales/en.json`: localized cleanup text.
- `src/components/config/__tests__/SysCogRetention.test.js`: rendered Vue/Element Plus tests with only the external request boundary replaced.
- `vitest.config.js`, `package.json`, `package-lock.json`: Vue SFC test support using the pinned `@vitejs/plugin-vue`.
- `vue.config.js`: production output directory.

The cleanup tab uses the existing admin route guard and `fetchWithAuth` helper. It sends configuration changes separately from manual deletion. Preview uses the saved configuration; editing/saving or a remote configuration-version change invalidates the previous preview. Loading the page never starts a cleanup. A manual run requires an unexpired preview and an explicit confirmation displaying the file count, space estimate and cutoff in Asia/Shanghai.

The API shapes are defined in `../docs/superpowers/specs/2026-10-29-local-retention-design.md`. Run timestamps are ISO strings; the UI formats them in Asia/Shanghai regardless of the browser timezone. The scope is local R2 `videos/` and subfolders, including image, video and audio files.
