## RimDeck 1.2.1

### Fixes
- **No more freezes while mod DLLs are read.** Listing mod settings and analysing Harmony patches read several hundred mod DLLs in one go, which could make the window stop responding for a while, especially right after a restart, when nothing was cached yet. They're now read in the background.
- **Save backups no longer pile up.** Starting the game backs up your newest save as before, but only when it changed since the last backup, and only the newest 10 backups are kept (saves are often 50 MB or more).

### Diagnostics
- If RimDeck ever stops responding, it now notes when, for how long and what it was doing in `logs/responsiveness.log` in its data folder (`%APPDATA%\RimDeck` on Windows), so the cause can be found.
