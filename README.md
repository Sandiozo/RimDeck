<div align="center">

<img src="docs/banner.jpg" alt="RimDeck" width="100%">

### A fast RimWorld mod manager and load order sorter

Auto-sort with explanations · live problem checks · texture and research analysis · mod settings without the game · one-click Workshop downloads

<sub>Free and open source · a modern alternative to RimSort and RimPy · RimWorld 1.4 to 1.7 · Windows</sub>

<br>

<a href="https://github.com/Sandiozo/RimDeck/releases/latest"><img alt="Download for Windows" src="https://img.shields.io/badge/Download_for_Windows-d8742b?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ3aGl0ZSIgc3Ryb2tlLXdpZHRoPSIyLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDN2MTIiLz48cGF0aCBkPSJtNyAxMCA1IDUgNS01Ii8+PHBhdGggZD0iTTUgMjFoMTQiLz48L3N2Zz4="></a>

<br>

<a href="https://github.com/Sandiozo/RimDeck/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Sandiozo/RimDeck?style=flat-square&label=release&color=d8742b"></a>
<a href="https://github.com/Sandiozo/RimDeck/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/Sandiozo/RimDeck/total?style=flat-square&color=6f9fc4"></a>
<img alt="RimWorld 1.7" src="https://img.shields.io/badge/RimWorld-1.7-e2a83e?style=flat-square">
<img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-8fb854?style=flat-square">
<a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/Sandiozo/RimDeck?style=flat-square&color=a39e94"></a>

<sub><a href="#install">Install</a> &nbsp;•&nbsp; <a href="#screenshots">Screenshots</a> &nbsp;•&nbsp; <a href="#what-it-does">Features</a> &nbsp;•&nbsp; <a href="docs/FEATURES.md">Full reference</a> &nbsp;•&nbsp; <a href="#build-from-source">Build</a> &nbsp;•&nbsp; <a href="https://github.com/Sandiozo/RimDeck/discussions">Discussions</a></sub>

<br><br>

<img src="docs/hero.jpg" alt="RimDeck showing an active load order, mod details and the research tree" width="100%">

</div>

<br>

| Fast | Explained sorting | Safe |
|:--|:--|:--|
| Scans 350+ mods in about a quarter of a second, without loading screens or refresh buttons. | Each auto-sort move shows the rule behind it. Nothing changes until you apply it. | RimDeck writes only `ModsConfig.xml` and the settings you edit, and backs them up first. Mod code is read, never run. |

## Install

1. Download **`RimDeck-Setup-x.y.z.exe`** from the [latest release](https://github.com/Sandiozo/RimDeck/releases/latest) and run it.
2. On first start, RimDeck finds RimWorld through Steam or imports your RimSort folders and rules.
3. RimDeck **updates itself** when a new version is released.

> [!NOTE]
> The installer is not code-signed yet, so Windows SmartScreen may show a warning. Select **More info → Run anyway**.

## Screenshots

| | |
|---|---|
| ![Mods](docs/screenshots/mods.png) | ![Sort preview](docs/screenshots/sort.png) |
| **Mods** — drag and drop, live problem badges, details and settings | **Auto-sort** — every move explained before anything changes |
| ![Textures](docs/screenshots/textures.png) | ![Research](docs/screenshots/research.png) |
| **Texture conflicts** — compare versions and pick per texture | **Research tree** — tidy, by era or in game positions, with problems flagged |
| ![Items](docs/screenshots/items.png) | ![Load time](docs/screenshots/loadtime.png) |
| **Items** — duplicate items added by several mods | **Load time** — measured startup phases and the heaviest mods |

## What it does

- **Load order** — drag and drop, multi-select, undo/redo, Ctrl+K search, filters like `is:error`, `is:outdated`, `v:1.6`, `is:new`.
- **Auto-sort** — About.xml rules, dependencies, RimSort's community rules and rules inferred from XML overrides, with the reason for every move.
- **Problem checks** — missing dependencies, broken load-order rules, incompatibilities, duplicates, outdated mods with updated replacements.
- **Texture conflicts** — see which mod's texture wins, compare side by side, with a slider or as a pixel diff (DDS too), and pick single textures.
- **Research tree and items** — every mod's research on one zoomable tree, and items that exist more than once.
- **Continue** — one click starts RimWorld straight into your latest save.
- **Mod settings** — its own page in the sidebar: edit any mod's settings without starting the game, including ones still at their defaults.
- **Game log** — groups errors and names the mods most likely responsible.
- **Workshop** — download mods and whole collections through SteamCMD (optional Steam login), with update checks.
- **Profiles** — separate setups, each with its own game install (game version) and its own mods and load order; switch from the title bar.
- **Saves** — see which mods a save used and load that list.
- **Find a broken mod** — a binary search that halves the suspects on each launch.

Full feature reference: [docs/FEATURES.md](docs/FEATURES.md).

## Build from source

```bash
npm install
npm run dev        # run with hot reload
npm run dist       # build the installer into release/
```

## Contributing

Bug reports, ideas and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md), or ask in [Discussions](https://github.com/Sandiozo/RimDeck/discussions). If RimDeck saves you time, a ⭐ helps other players find it.

## License

[MIT](LICENSE) © Sandis (Sandiozo)
