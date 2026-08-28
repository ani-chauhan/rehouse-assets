# Rehouse Assets

After Effects ScriptUI panel that organizes a project's panel structure and consolidates
footage onto disk.

## What it does

- **Rehouse Used** — walks every "main comp" (a `CompItem` sitting directly in the
  `001 Comps` panel folder), files precomps and footage into the standard panel/disk
  layout, and consolidates footage living outside the project's own `Assets/` tree by
  copying it in and relinking. With **Reorganize legacy folders** checked, it also
  finds comps/footage sitting in any other top-level folder (e.g. leftover `Comps`,
  `Pre comps`, `Assets` folders from an imported project) and files them into the
  standard structure — comps always go to `002 Pre Comps` (never `001 Comps`; main-comp
  status is only ever granted by manually placing a comp in `001 Comps`), footage is
  bucketed by type. Comps that land in `002 Pre Comps` this way and turn out to be
  unused get caught by the next Remove Unused pass.
- **Remove Unused from Project** — deletes anything unreachable from a main comp from
  the project panel, regardless of where its file lives. Never touches disk.
- **Remove Unused from Disk** — deletes the underlying file for any unreachable footage
  item AND removes it from the project panel, but only for files that live inside the
  current project's own folder. Anything unreachable that isn't a project-folder
  footage file (a comp, or footage still pointing at an imported project's folder) is
  left completely untouched — that source project owns those files, and this tool's
  convention is to copy such footage in (Rehouse Used) rather than delete it out from
  under the other project.
- **Fix Broken Links** — re-finds offline footage anywhere under the project folder by
  filename and relinks it, without touching disk.
- **Add Main Comps Folder** — creates the `001 Comps` panel folder (if it doesn't
  already exist) so you can drop your main comps into it before running Rehouse Used.

Convention it enforces:

```
Panel:  001 Comps / 002 Pre Comps / 003 Assets (01 Audio, 02 Images, 03 Videos, 04 3D, 05 Other) / 004 Imports
Disk:   <Project Folder>/Assets/{Audio,Images,Videos,3D,Other}, <Project Folder>/Renders
```

## v1 scope notes (deliberate, not oversights)

- Proxies are detected and reported, not consolidated — `AVItem.setProxy()` doesn't
  preserve Interpret Footage settings the way `replace()`/`replaceWithSequence()` does.
  Relink proxies by hand.
- Sequence copies go file-by-file through `File.copy()` (verified, resumable-by-rerun)
  rather than a shelled-out `cp` batch — slower on network volumes, but every copy is
  individually verified and there's no shell-quoting risk.
- Disk operations never participate in AE's undo stack. All file-system work finishes
  and is verified *before* the project undo group opens, so undoing a Rehouse reverts
  the project panel while any already-copied files stay on disk as harmless orphans
  (recognized as already-in-place on the next run).

## Install

After Effects loads ScriptUI panels from each version's `Scripts/ScriptUI Panels/`
folder. This repo is the source of truth; installed copies are plain file copies (not
symlinks) at:

- `/Applications/Adobe After Effects 2025/Scripts/ScriptUI Panels/Rehouse Assets.jsx`
- `/Applications/Adobe After Effects 2026/Scripts/ScriptUI Panels/Rehouse Assets.jsx`
- `/Users/anirudh.chauhan/Documents/AE Scripts/Rehouse Assets.jsx` (personal reference copy)

After editing `Rehouse Assets.jsx` here, copy it to those locations to pick up changes
in AE (the app folders are owned by root, so this needs `sudo`):

```sh
sudo cp "Rehouse Assets.jsx" "/Applications/Adobe After Effects 2025/Scripts/ScriptUI Panels/Rehouse Assets.jsx"
sudo cp "Rehouse Assets.jsx" "/Applications/Adobe After Effects 2026/Scripts/ScriptUI Panels/Rehouse Assets.jsx"
cp "Rehouse Assets.jsx" "/Users/anirudh.chauhan/Documents/AE Scripts/Rehouse Assets.jsx"
```

Note: the previously installed copies are still named `Ani Rehouse.jsx` on disk. They
need to be removed/renamed separately when you sync this version over — see below.
