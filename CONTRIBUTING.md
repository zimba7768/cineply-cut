# Contributing to Cineply Cut

Thanks for helping. Bug reports, feature ideas, and pull requests are all welcome.

## Getting started

```bash
git clone https://github.com/zimba7768/cineply-cut.git
cd cineply-cut
npm install
npm run dev
```

You need Node.js 24+. FFmpeg is bundled through `ffmpeg-static`, so you don't need to install it separately.

## Before you open a pull request

- `npm run typecheck` and `npm run build` must pass. CI runs both on every PR.
- Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Every project edit goes through the undoable `mutate()` store action, and the preview and export share one compositor.
- Keep each PR focused on one feature or fix, and describe how you tested it.

## Good first contributions

- **New transitions:** add a `TransitionDef` in `src/renderer/src/engine/transitions/`.
- **New video effects:** add a `VideoEffectDef` in `src/renderer/src/engine/effects/`.
- **New audio effects:** add an `AudioEffectDef` in `src/renderer/src/audio/effects.ts`.
- **New title templates:** add one in `src/renderer/src/engine/titles/`.
- **New Higgsfield models:** add catalog entries in `src/renderer/src/lib/higgsfield.ts`.

Each one is a self-contained definition with a parameter list. The inspector renders its controls automatically.

## Code style

TypeScript strict mode, 2-space indent, single quotes, no semicolons. Match the code around you.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
