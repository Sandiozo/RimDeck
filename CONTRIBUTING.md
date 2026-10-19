# Contributing to RimDeck

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and asking for features

- **Bugs:** open an [issue](https://github.com/Sandiozo/RimDeck/issues/new/choose) with the bug report form. Include your RimDeck version (title bar), RimWorld version, and a screenshot or error text.
- **Questions and ideas:** use [Discussions](https://github.com/Sandiozo/RimDeck/discussions).
- **A problem inside a specific mod** belongs on that mod's Workshop page.

## Working on the code

RimDeck is an Electron app written in TypeScript with React.

```bash
npm install
npm run dev        # starts the app with hot reload
npm run typecheck  # must pass before a pull request
npm run dist       # builds the Windows installer into release/
```

- `src/main` runs in Electron's main process: scanning mods, reading XML and DLLs, writing ModsConfig.xml.
- `src/renderer` is the interface (React, zustand store in `store.ts`).
- `src/shared` holds types and the sorting and validation logic used by both.
- `helper/RimDeckContinue` is the small C# mod behind the Continue button.

Keep changes focused, match the style of the code around them, and describe what you tested in the pull request.

RimDeck never runs mod code: DLLs and XML are only read. Please keep it that way.
