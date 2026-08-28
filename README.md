# Ani Rehouse

After Effects ScriptUI panel that organizes a project's panel structure and consolidates
footage onto disk.

## What it does

- **Rehouse Used** — walks every "main comp" (a `CompItem` sitting directly in the
  `001 Comps` panel folder), files precomps and footage into the standard panel/disk
  layout, and consolidates footage living outside the project's own `Assets/` tree by
  copying it in and relinking.
- **Remove Unused** — deletes anything unreachable from a main comp from the project
  panel only. Never touches a file on disk.
- **Fix Broken Links** — re-finds offline footage anywhere under the project folder by
  filename and relinks it, without touching disk.

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

- `/Applications/Adobe After Effects 2025/Scripts/ScriptUI Panels/Ani Rehouse.jsx`
- `/Applications/Adobe After Effects 2026/Scripts/ScriptUI Panels/Ani Rehouse.jsx`
- `/Users/anirudh.chauhan/Documents/AE Scripts/Ani Rehouse.jsx` (personal reference copy)

After editing `Ani Rehouse.jsx` here, copy it to those locations to pick up changes in
AE (the app folders are owned by root, so this needs `sudo`):

```sh
sudo cp "Ani Rehouse.jsx" "/Applications/Adobe After Effects 2025/Scripts/ScriptUI Panels/Ani Rehouse.jsx"
sudo cp "Ani Rehouse.jsx" "/Applications/Adobe After Effects 2026/Scripts/ScriptUI Panels/Ani Rehouse.jsx"
cp "Ani Rehouse.jsx" "/Users/anirudh.chauhan/Documents/AE Scripts/Ani Rehouse.jsx"
```
