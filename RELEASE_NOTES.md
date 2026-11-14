## RimDeck 1.3.0

### New
- **Report a bug.** The bug button under Settings (also in Settings → Help and the Ctrl K palette) builds a report from your description, your RimDeck, system and game versions, and RimDeck's recent errors, plus your active mod list if you leave that ticked. You read the whole report first, then open it as a GitHub issue, copy it, or save it to a file. Nothing is ever sent automatically.
- **RimDeck notices its own crashes.** Errors and crashes are written to `logs/crash.log` in its data folder, with your user name removed from paths. After an error, or after a run that did not close normally, a banner offers to report it.

### Faster
- **Large mod lists stay quick.** The mod lists now draw only the rows on screen. With about 2,400 mods, activating 2,000 at once went from about two seconds to under a tenth of a second, and scrolling, filtering and selecting no longer lag.
- **The window keeps responding while mods are read.** Defs, textures, mod DLLs, the game log and DDS previews are now read in background workers, which is what Research, Items, Textures, Load time and Search rely on. If workers can't start on a system, RimDeck does the work the old way.

### Safer with your files
- **A profile no longer puts an old mod list back.** When `ModsConfig.xml` was changed outside RimDeck (by the game or another tool), switching profiles could write the older list over it. The profile now takes the file's list, and the list it had before is kept among the backups.
- **Settings that can't be read are never silently reset.** RimDeck tries again, and a damaged file is set aside as `<name>.damaged-<time>` instead of being replaced with defaults.
- **Backups can't overwrite each other.** Backups of `ModsConfig.xml` and of saves get unique, time-stamped names, and `ModsConfig.xml` is left alone if it could not be backed up first.
- **Closing with unsaved changes asks first.** And only one RimDeck runs at a time: starting it again brings the open window forward.
- **A failed download can't leave a half-replaced mod.** The new copy is swapped in only once it is complete.

### Fixes
- **Auto-sort** breaks a dependency loop at a mod that is really part of the loop, counts an alternative dependency as met, and can no longer create a loop from its own guessed ordering hints.
- **Find a broken mod** no longer gets stuck on mods that depend on each other; it reports them as a group.
- **Steam login:** the Steam Guard code field now appears when Steam asks for a code.
- **Load time:** the bars are visible again, and durations read as "2m 34s".
- **Right-click menu** stays inside the window instead of running off its edge.
- **Light theme:** the labels on texture sliders and the research era chips are readable.
- **Research, Items and Search** no longer show results from before a profile switch or from an earlier search.
- **Play and Continue** can't be started twice by a double click, and a failed start now says why.
- **macOS and Linux:** texts say "Trash" instead of "Recycle Bin", and `.deb`, `.rpm` and pacman installs no longer install an update on quit, only when you choose to restart.
- Many smaller fixes to layout, wording, keyboard handling (Escape closes the top-most menu or dialog) and error messages.
