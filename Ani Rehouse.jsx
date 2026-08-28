#target aftereffects
// Ani Rehouse — After Effects project organizer
//
// Convention:
//   Panel:  001 Comps / 002 Pre Comps / 003 Assets (01 Audio, 02 Images, 03 Videos, 04 3D, 05 Other) / 004 Imports
//   Disk:   <Project Folder>/Assets/{Audio,Images,Videos,3D,Other}, <Project Folder>/Renders
//
// A "main comp" is any CompItem sitting directly inside "001 Comps". Rehouse Used walks every
// main comp's layer tree, files precomps and footage into the right folders, and consolidates
// any footage living outside the project's own Assets/ tree by copying it in and relinking.
// Remove Unused deletes anything unreachable from a main comp from the PROJECT PANEL ONLY —
// it never touches a file on disk.
//
// v1 scope notes (deliberate, not oversights):
//   - Proxies are detected and reported, not consolidated — AVItem.setProxy() does not preserve
//     Interpret Footage settings the way replace()/replaceWithSequence() does, so auto-relinking
//     a proxy risks silently changing alpha/frame-rate interpretation. Relink proxies by hand.
//   - Large sequence copies go through File.copy() per frame (verified, resumable-by-rerun), not
//     a shelled-out `cp` batch — slower on network volumes, but keeps every copy individually
//     verified and avoids shell-quoting risk.
//
// Disk operations never participate in After Effects' undo stack, so this script always finishes
// all file-system work (and verifies it) BEFORE opening a project undo group. If you undo a
// Rehouse, the project panel reverts; any files already copied stay on disk as harmless orphans
// and are recognized as already-in-place (or deduped) on the next run.

(function (thisObj) {

    var SCRIPT_NAME = "Ani Rehouse";
    var SCRIPT_VERSION = "1.0.0";
    var SETTINGS_SECTION = "AniRehouse";

    // ------------------------------------------------------------------ CFG

    var CFG = {
        panel: {
            comps: "001 Comps",
            precomps: "002 Pre Comps",
            assets: "003 Assets",
            imports: "004 Imports",
            shared: "_Shared"
        },
        buckets: [
            { key: "audio", aeName: "01 Audio", diskName: "Audio",
              exts: ["wav","mp3","aif","aiff","aifc","m4a","flac","aac","ogg","oga","caf","wma","au"] },
            { key: "images", aeName: "02 Images", diskName: "Images",
              exts: ["png","jpg","jpeg","jpe","jfif","tif","tiff","psd","psb","ai","eps","exr","dpx",
                     "cin","tga","bmp","gif","hdr","sgi","rgb","pict","pct","webp","heic","heif",
                     "jp2","j2k","svg"] },
            { key: "videos", aeName: "03 Videos", diskName: "Videos",
              exts: ["mov","mp4","m4v","avi","mxf","mpg","mpeg","m2v","webm","mkv","wmv","r3d",
                     "braw","dv","ts","mts","m2ts"] },
            { key: "3d", aeName: "04 3D", diskName: "3D",
              exts: ["obj","c4d","fbx","abc","glb","gltf","usd","usda","usdc","usdz","blend",
                     "3ds","dae","stl"] },
            { key: "other", aeName: "05 Other", diskName: "Other", exts: [] }
        ],
        diskAssets: "Assets",
        diskRenders: "Renders",
        seqExcludeExts: { "gif": true, "psd": true, "psb": true },
        maxWalkIterations: 200000
    };

    // -------------------------------------------------------------------- U

    var U = {
        each: function (arr, fn) { for (var i = 0; i < arr.length; i++) fn(arr[i], i); },
        map: function (arr, fn) { var o = []; for (var i = 0; i < arr.length; i++) o.push(fn(arr[i], i)); return o; },
        indexOf: function (arr, v) { for (var i = 0; i < arr.length; i++) if (arr[i] === v) return i; return -1; },
        safe: function (fn, dflt) { try { return fn(); } catch (e) { return dflt; } },
        fmtBytes: function (n) {
            if (!n || n < 1024) return (n || 0) + " B";
            var units = ["KB", "MB", "GB", "TB"], v = n;
            for (var i = 0; i < units.length; i++) {
                v = v / 1024;
                if (v < 1024 || i === units.length - 1) return v.toFixed(1) + " " + units[i];
            }
            return n + " B";
        },
        newSet: function () {
            var store = {}, n = 0;
            return {
                add: function (k) { var kk = "#" + k; if (!store[kk]) { store[kk] = true; n++; } },
                has: function (k) { return !!store["#" + k]; },
                keys: function () { var o = []; for (var kk in store) if (store.hasOwnProperty(kk)) o.push(kk.substr(1)); return o; },
                size: function () { return n; }
            };
        },
        newMap: function () {
            var store = {}, n = 0;
            return {
                set: function (k, v) { var kk = "#" + k; if (!(kk in store)) n++; store[kk] = v; },
                get: function (k) { var kk = "#" + k; return store.hasOwnProperty(kk) ? store[kk] : undefined; },
                has: function (k) { return store.hasOwnProperty("#" + k); },
                keys: function () { var o = []; for (var kk in store) if (store.hasOwnProperty(kk)) o.push(kk.substr(1)); return o; },
                size: function () { return n; }
            };
        }
    };

    // ------------------------------------------------------------------- Fs
    // Everything in this module stays in File.fsName space (platform-native, not percent-encoded).
    // file.name / file.path are never used here — mixing encoded and decoded path spaces is the
    // most common source of bugs in After Effects relink scripts.

    var Fs = {
        baseName: function (f) {
            var s = f.fsName, i = s.lastIndexOf("/");
            return i === -1 ? s : s.substr(i + 1);
        },
        extOf: function (name) {
            var i = name.lastIndexOf(".");
            return i <= 0 ? "" : name.substr(i + 1).toLowerCase();
        },
        stripExt: function (name) {
            var i = name.lastIndexOf(".");
            return i <= 0 ? name : name.substr(0, i);
        },
        normPath: function (fsName) {
            var s = fsName.toLowerCase();
            while (s.length > 1 && s.charAt(s.length - 1) === "/") s = s.substr(0, s.length - 1);
            return s;
        },
        isInside: function (file, folder) {
            if (!file || !folder) return false;
            var a = Fs.normPath(file.fsName), b = Fs.normPath(folder.fsName);
            return a.length > b.length && a.substr(0, b.length) === b && a.charAt(b.length) === "/";
        },
        mkdirp: function (folder) {
            if (folder.exists) return true;
            var chain = [], f = folder, guard = 0;
            while (f && !f.exists) {
                chain.push(f);
                f = f.parent;
                if (++guard > 64) return false;
            }
            for (var i = chain.length - 1; i >= 0; i--) {
                if (!chain[i].exists && !chain[i].create()) return false;
            }
            return folder.exists;
        },
        listNamesLower: function (folder) {
            var m = U.newMap();
            if (!folder || !folder.exists) return m;
            var files = folder.getFiles();
            if (!files) return m;
            for (var i = 0; i < files.length; i++) {
                if (files[i] instanceof File) m.set(Fs.baseName(files[i]).toLowerCase(), files[i]);
            }
            return m;
        },
        uniqueName: function (baseName, takenLowerMap) {
            if (!takenLowerMap.has(baseName.toLowerCase())) return baseName;
            var ext = Fs.extOf(baseName), stem = Fs.stripExt(baseName), n = 1;
            while (true) {
                n++;
                var candidate = ext ? (stem + "_" + n + "." + ext) : (stem + "_" + n);
                if (!takenLowerMap.has(candidate.toLowerCase())) return candidate;
            }
        },
        child: function (folder, name) { return new File(folder.fsName + "/" + name); },
        childFolder: function (folder, name) { return new Folder(folder.fsName + "/" + name); },
        copyVerified: function (srcFile, dstFile) {
            if (!dstFile.parent.exists && !Fs.mkdirp(dstFile.parent)) {
                return { ok: false, error: "could not create destination folder" };
            }
            var ok = srcFile.copy(dstFile);
            if (!ok) return { ok: false, error: String(dstFile.error || srcFile.error || "copy() returned false") };
            if (!dstFile.exists) return { ok: false, error: "destination missing after copy" };
            var sameSize = U.safe(function () { return dstFile.length === srcFile.length; }, false);
            if (!sameSize) return { ok: false, error: "size mismatch after copy" };
            return { ok: true };
        },
        // Copy-then-verify-then-delete, never a bare rename: on a case-insensitive filesystem
        // (e.g. the user's SMB NAS) a rename differing only in case can resolve to the same
        // inode, and deleting "the original" afterward would destroy the just-written file.
        moveVerified: function (srcFile, dstFile) {
            var r = Fs.copyVerified(srcFile, dstFile);
            if (!r.ok) return r;
            if (Fs.normPath(srcFile.fsName) === Fs.normPath(dstFile.fsName)) return { ok: true };
            if (!srcFile.remove()) return { ok: true, warning: "copied but could not remove original: " + srcFile.fsName };
            return { ok: true };
        },
        sameFile: function (a, b) {
            return U.safe(function () {
                if (!a.exists || !b.exists) return false;
                if (a.length !== b.length) return false;
                var am = a.modified ? a.modified.getTime() : 0;
                var bm = b.modified ? b.modified.getTime() : 0;
                return Math.abs(am - bm) < 2000;
            }, false);
        }
    };

    // ------------------------------------------------------------- Classify

    var Classify = {
        bucketForExt: function (ext) {
            ext = (ext || "").toLowerCase();
            for (var i = 0; i < CFG.buckets.length; i++) {
                if (U.indexOf(CFG.buckets[i].exts, ext) !== -1) return CFG.buckets[i];
            }
            return CFG.buckets[CFG.buckets.length - 1];
        },
        isSeqCandidateExt: function (ext) {
            ext = (ext || "").toLowerCase();
            if (CFG.seqExcludeExts[ext]) return false;
            return U.indexOf(CFG.buckets[1].exts, ext) !== -1; // images bucket
        }
    };

    // ------------------------------------------------------------------ Proj

    var Proj = {
        snapshotItems: function () {
            var out = [];
            for (var i = 1; i <= app.project.numItems; i++) out.push(app.project.item(i));
            return out;
        },
        findChildFolder: function (parent, name) {
            var n = U.safe(function () { return parent.numItems; }, 0);
            for (var i = 1; i <= n; i++) {
                var it = U.safe(function () { return parent.item(i); }, null);
                if (it && it instanceof FolderItem && it.name === name) return it;
            }
            return null;
        },
        ensureFolder: function (parent, name) {
            var found = Proj.findChildFolder(parent, name);
            if (found) return found;
            var f = app.project.items.addFolder(name);
            f.parentFolder = parent;
            return f;
        },
        // Path of the folder CONTAINING item (not including item's own name).
        folderPathOf: function (item) {
            var parts = [], f = U.safe(function () { return item.parentFolder; }, null), guard = 0;
            while (f && f.id !== app.project.rootFolder.id && guard < 32) {
                parts.unshift(f.name);
                f = U.safe(function () { return f.parentFolder; }, null);
                guard++;
            }
            return parts.join(" / ");
        },
        // Path of a folder ITSELF (including its own name), for display of a move target.
        folderFullPath: function (folderItem) {
            var parts = [], f = folderItem, guard = 0;
            while (f && f.id !== app.project.rootFolder.id && guard < 32) {
                parts.unshift(f.name);
                f = U.safe(function () { return f.parentFolder; }, null);
                guard++;
            }
            return parts.join(" / ");
        },
        sourceKind: function (item) {
            var src = U.safe(function () { return item.mainSource; }, null);
            if (!src) return "unknown";
            if (src instanceof SolidSource) return "solid";
            if (src instanceof PlaceholderSource) return "placeholder";
            if (src instanceof FileSource) {
                var missing = U.safe(function () { return item.footageMissing; }, false);
                return missing ? "missing" : "file";
            }
            return "unknown";
        },
        itemFile: function (item) { return U.safe(function () { return item.file; }, null); }
    };

    // ------------------------------------------------------------------- Seq

    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    var Seq = {
        // Detects an image sequence: not-still footage with a still-image extension and at least
        // one numbered sibling. There is no isSequence property in the scripting DOM; this is a
        // heuristic and known to miss/misfire on animated GIFs (excluded above), multi-layer PSDs
        // (excluded above), and multi-part EXRs (harmless — different prefixes stay separate).
        detect: function (item) {
            if (Proj.sourceKind(item) !== "file") return null;
            var f = Proj.itemFile(item);
            if (!f || !f.exists) return null;
            var isStill = U.safe(function () { return item.mainSource.isStill; }, true);
            if (isStill !== false) return null;
            var base = Fs.baseName(f), ext = Fs.extOf(base);
            if (!Classify.isSeqCandidateExt(ext)) return null;
            var stem = Fs.stripExt(base);
            var m = /^(.*?)(\d+)$/.exec(stem);
            if (!m) return null;
            var prefix = m[1], pad = m[2].length;
            var re = new RegExp("^" + escapeRe(prefix) + "\\d{" + pad + "}\\." + escapeRe(ext) + "$", "i");
            var all = f.parent.getFiles();
            if (!all) return null;
            var members = [];
            for (var i = 0; i < all.length; i++) {
                if (all[i] instanceof File && re.test(Fs.baseName(all[i]))) members.push(all[i]);
            }
            if (members.length < 2) return null;
            members.sort(function (a, b) {
                var an = Fs.baseName(a), bn = Fs.baseName(b);
                return an < bn ? -1 : (an > bn ? 1 : 0);
            });
            var seqBase = prefix.replace(/[_\-. ]+$/, "");
            if (!seqBase) seqBase = "sequence";
            return { members: members, first: members[0], ext: ext, base: sanitizeFolderName(seqBase) };
        }
    };

    // ---------------------------------------------------------------- Interp

    var INTERP_PROPS = ["alphaMode", "premulColor", "invertAlpha", "conformFrameRate", "loop",
                         "removePulldown", "fieldSeparationType", "highQualityFieldSeparation"];

    var Interp = {
        capture: function (item) {
            var src = U.safe(function () { return item.mainSource; }, null);
            if (!src) return null;
            var snap = {};
            for (var i = 0; i < INTERP_PROPS.length; i++) {
                var p = INTERP_PROPS[i];
                snap[p] = U.safe(function () { return src[p]; }, undefined);
            }
            return snap;
        },
        // Restore order matters: several of these throw if set out of sequence (e.g. frame-rate
        // and field-separation properties on still footage, or in the wrong pulldown/field
        // interlock order). Each set is independently guarded so one failure doesn't lose the rest.
        restore: function (item, snap) {
            var warnings = [];
            if (!snap) return warnings;
            var src = U.safe(function () { return item.mainSource; }, null);
            if (!src) return warnings;
            var isStill = U.safe(function () { return src.isStill; }, true);

            function trySet(prop, val) {
                if (val === undefined) return;
                try { src[prop] = val; } catch (e) { warnings.push(prop + ": " + e.toString()); }
            }

            trySet("alphaMode", snap.alphaMode);
            if (snap.alphaMode === AlphaMode.PREMULTIPLIED) trySet("premulColor", snap.premulColor);
            trySet("invertAlpha", snap.invertAlpha);

            if (!isStill) {
                trySet("fieldSeparationType", snap.fieldSeparationType);
                var fsNow = U.safe(function () { return src.fieldSeparationType; }, FieldSeparationType.OFF);
                if (fsNow !== FieldSeparationType.OFF) {
                    trySet("removePulldown", snap.removePulldown);
                    trySet("highQualityFieldSeparation", snap.highQualityFieldSeparation);
                }
                trySet("conformFrameRate", snap.conformFrameRate);
                trySet("loop", snap.loop);
            }
            return warnings;
        }
    };

    // ----------------------------------------------------------------- Graph
    // usedIn is deliberately never used here: the scripting docs never define whether it is
    // transitive, and the array is a non-live snapshot. Reachability is built by walking every
    // main comp's layer tree directly. Text/shape layers have layer.source === null; camera/light
    // layers don't have the property at all (undefined) — a single falsy check handles both
    // without any fragile instanceof-AVLayer test (which itself misses text/shape layers).

    var Graph = {
        build: function (mainComps) {
            var reach = U.newSet();
            var owners = U.newMap();       // itemId -> Set of owning main-comp ids
            var precompsMap = U.newMap();  // itemId -> CompItem
            var footageMap = U.newMap();   // itemId -> FootageItem
            var mainIds = U.newSet();

            U.each(mainComps, function (c) { mainIds.add(c.id); reach.add(c.id); });

            function record(item, rootId) {
                reach.add(item.id);
                var o = owners.get(item.id);
                if (!o) { o = U.newSet(); owners.set(item.id, o); }
                o.add(rootId);
            }

            U.each(mainComps, function (root) {
                var visited = U.newSet();
                visited.add(root.id);
                var stack = [root], guard = 0;
                while (stack.length) {
                    if (++guard > CFG.maxWalkIterations) break;
                    var comp = stack.pop();
                    var n = U.safe(function () { return comp.numLayers; }, 0);
                    for (var i = 1; i <= n; i++) {
                        var layer = U.safe(function () { return comp.layer(i); }, null);
                        if (!layer) continue;
                        var src = U.safe(function () { return layer.source; }, null);
                        if (!src) continue; // text/shape = null, camera/light = undefined
                        record(src, root.id);
                        if (src instanceof CompItem) {
                            if (mainIds.has(src.id)) continue; // main comps are traversal boundaries
                            precompsMap.set(src.id, src);
                            if (!visited.has(src.id)) { visited.add(src.id); stack.push(src); }
                        } else if (src instanceof FootageItem) {
                            footageMap.set(src.id, src);
                        }
                    }
                }
            });

            return { reach: reach, owners: owners, precompsMap: precompsMap, footageMap: footageMap, mainIds: mainIds };
        }
    };

    // ---------------------------------------------------------------- Locate
    // Supports "Fix Broken Links": when a sibling project sharing the same project folder has
    // already rehoused a shared asset, this project's link to the old path breaks even though
    // the file still exists somewhere under the same folder — just moved. This indexes every
    // file under the project root once (excluding Renders and any Synology "#recycle"/"#snapshot"
    // folder) so missing items can be matched by filename without touching disk.

    var Locate = {
        buildFileIndex: function (rootFolder, excludeFolders) {
            var index = U.newMap(); // lowercase basename -> array of File
            var guard = { count: 0 };
            function walk(folder, depth) {
                if (depth > 24 || guard.count > 200000) return;
                var entries = folder.getFiles();
                if (!entries) return;
                for (var i = 0; i < entries.length; i++) {
                    guard.count++;
                    if (guard.count > 200000) return;
                    var e = entries[i];
                    if (e instanceof Folder) {
                        var nm = Fs.baseName(e);
                        if (nm.charAt(0) === "#") continue; // #recycle / #snapshot on Synology shares
                        var skip = false;
                        for (var j = 0; j < excludeFolders.length; j++) {
                            if (Fs.normPath(e.fsName) === Fs.normPath(excludeFolders[j].fsName)) { skip = true; break; }
                        }
                        if (skip) continue;
                        walk(e, depth + 1);
                    } else if (e instanceof File) {
                        var key = Fs.baseName(e).toLowerCase();
                        var arr = index.get(key);
                        if (!arr) { arr = []; index.set(key, arr); }
                        arr.push(e);
                    }
                }
            }
            walk(rootFolder, 0);
            return index;
        }
    };

    // ---------------------------------------------------------- helper fns

    function sanitizeFolderName(name) {
        var s = (name || "Untitled").replace(/[\/\\:*?"<>|]/g, "_");
        s = s.replace(/[.\s]+$/, "");
        if (!s) s = "Untitled";
        if (s.length > 80) s = s.substr(0, 80);
        return s;
    }

    function findMainCompById(mainComps, idStr) {
        var id = parseInt(idStr, 10);
        for (var i = 0; i < mainComps.length; i++) if (mainComps[i].id === id) return mainComps[i];
        return null;
    }

    function depthOf(item) {
        var d = 0, f = U.safe(function () { return item.parentFolder; }, null), guard = 0;
        while (f && f.id !== app.project.rootFolder.id && guard < 32) { d++; f = U.safe(function () { return f.parentFolder; }, null); guard++; }
        return d;
    }

    // A missing FootageItem retains its cached isStill/duration metadata from when it was last
    // online, so a sequence can still be recognized even though the original file is gone —
    // there is nothing on disk at the old path to inspect directly.
    function seqPatternForMissing(item, basename) {
        var isStill = U.safe(function () { return item.mainSource.isStill; }, true);
        var ext = Fs.extOf(basename);
        if (isStill !== false || !Classify.isSeqCandidateExt(ext)) return null;
        var stem = Fs.stripExt(basename);
        var m = /^(.*?)(\d+)$/.exec(stem);
        if (!m) return null;
        return { prefix: m[1], pad: m[2].length, ext: ext };
    }

    function gatherSequenceMembers(folder, pattern) {
        var re = new RegExp("^" + escapeRe(pattern.prefix) + "\\d{" + pattern.pad + "}\\." + escapeRe(pattern.ext) + "$", "i");
        var all = folder.getFiles();
        if (!all) return [];
        var members = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i] instanceof File && re.test(Fs.baseName(all[i]))) members.push(all[i]);
        }
        members.sort(function (a, b) {
            var an = Fs.baseName(a), bn = Fs.baseName(b);
            return an < bn ? -1 : (an > bn ? 1 : 0);
        });
        return members;
    }

    function checkProxyWarning(item, plan) {
        var proxy = U.safe(function () { return item.proxySource; }, null);
        if (!proxy || !(proxy instanceof FileSource)) return;
        var pf = U.safe(function () { return proxy.file; }, null);
        if (pf) plan.warnings.push(item.name + " has a proxy at " + pf.fsName + " — proxies are not auto-consolidated; relink manually if needed.");
    }

    function scanPropertyGroupForExpressions(pg, names, re, depth) {
        if (depth > 12) return;
        var n = U.safe(function () { return pg.numProperties; }, 0);
        for (var i = 1; i <= n; i++) {
            var p = U.safe(function () { return pg.property(i); }, null);
            if (!p) continue;
            var hasExpr = U.safe(function () { return p.canSetExpression && p.expressionEnabled; }, false);
            if (hasExpr) {
                var expr = U.safe(function () { return p.expression; }, "");
                re.lastIndex = 0;
                var m;
                while ((m = re.exec(expr))) names.add(m[1].toLowerCase());
            }
            var isGroup = U.safe(function () { return p.numProperties !== undefined; }, false);
            if (isGroup) scanPropertyGroupForExpressions(p, names, re, depth + 1);
        }
    }

    function scanExpressionReferences() {
        var names = U.newSet();
        var re = /(?:comp|footage)\s*\(\s*["']([^"']+)["']\s*\)/g;
        var allComps = [];
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = U.safe(function () { return app.project.item(i); }, null);
            if (it instanceof CompItem) allComps.push(it);
        }
        U.each(allComps, function (comp) {
            var n = U.safe(function () { return comp.numLayers; }, 0);
            for (var li = 1; li <= n; li++) {
                var layer = U.safe(function () { return comp.layer(li); }, null);
                if (!layer) continue;
                scanPropertyGroupForExpressions(layer, names, re, 0);
            }
        });
        return names;
    }

    // --------------------------------------------------------------- Planner
    // Pure: reads the project and the filesystem, writes nothing. All mutation happens in Exec.

    function buildContext() {
        if (!app.project.file) {
            return { error: "Save your project first — the project's own folder is where Assets/ and Renders/ get created." };
        }
        var aep = app.project.file;
        var projRoot = aep.parent;
        var assetsRootDisk = Fs.childFolder(projRoot, CFG.diskAssets);
        var rendersDisk = Fs.childFolder(projRoot, CFG.diskRenders);
        var bucketDiskFolders = {};
        U.each(CFG.buckets, function (b) { bucketDiskFolders[b.key] = Fs.childFolder(assetsRootDisk, b.diskName); });

        var root = app.project.rootFolder;
        var compsFolder = Proj.ensureFolder(root, CFG.panel.comps);
        var precompsFolder = Proj.ensureFolder(root, CFG.panel.precomps);
        var assetsFolder = Proj.ensureFolder(root, CFG.panel.assets);
        var bucketAEFolders = {};
        U.each(CFG.buckets, function (b) { bucketAEFolders[b.key] = Proj.ensureFolder(assetsFolder, b.aeName); });
        var importsFolder = Proj.ensureFolder(root, CFG.panel.imports);

        var mainComps = [];
        var nMain = U.safe(function () { return compsFolder.numItems; }, 0);
        for (var i = 1; i <= nMain; i++) {
            var it = U.safe(function () { return compsFolder.item(i); }, null);
            if (it && it instanceof CompItem) mainComps.push(it);
        }

        var graph = Graph.build(mainComps);

        return {
            aep: aep, projRoot: projRoot, assetsRootDisk: assetsRootDisk, rendersDisk: rendersDisk,
            bucketDiskFolders: bucketDiskFolders,
            compsFolder: compsFolder, precompsFolder: precompsFolder, assetsFolder: assetsFolder,
            bucketAEFolders: bucketAEFolders, importsFolder: importsFolder,
            mainComps: mainComps, graph: graph,
            stampNumItems: app.project.numItems, stampAep: aep.fsName
        };
    }

    function buildRehousePlan(ctx, opts) {
        var plan = {
            kind: "rehouse",
            createDiskFolders: [], panelMoves: [], diskCopies: [], relinks: [],
            skips: [], warnings: [],
            stampNumItems: ctx.stampNumItems, stampAep: ctx.stampAep,
            mainCompCount: ctx.mainComps.length
        };

        function needDisk(folder) { if (!folder.exists) plan.createDiskFolders.push(folder); }
        needDisk(ctx.assetsRootDisk);
        U.each(CFG.buckets, function (b) { needDisk(ctx.bucketDiskFolders[b.key]); });
        needDisk(ctx.rendersDisk);

        var reservedByFolder = U.newMap();
        function reserveName(folder, name) {
            var key = Fs.normPath(folder.fsName);
            var m = reservedByFolder.get(key);
            if (!m) { m = Fs.listNamesLower(folder); reservedByFolder.set(key, m); }
            var unique = Fs.uniqueName(name, m);
            m.set(unique.toLowerCase(), true);
            return unique;
        }

        // ---- Precomps ----
        var precompIds = ctx.graph.precompsMap.keys();
        U.each(precompIds, function (idStr) {
            var item = ctx.graph.precompsMap.get(idStr);
            var ownerSet = ctx.graph.owners.get(idStr);
            var ownerIds = ownerSet ? ownerSet.keys() : [];
            var targetFolder;
            if (opts.precompFolders) {
                if (ownerIds.length >= 2) {
                    targetFolder = Proj.ensureFolder(ctx.precompsFolder, CFG.panel.shared);
                } else {
                    var ownerComp = findMainCompById(ctx.mainComps, ownerIds[0]);
                    var name = sanitizeFolderName(ownerComp ? ownerComp.name : ("Comp " + ownerIds[0]));
                    targetFolder = Proj.ensureFolder(ctx.precompsFolder, name);
                }
            } else {
                targetFolder = ctx.precompsFolder;
            }
            var curParentId = U.safe(function () { return item.parentFolder.id; }, -1);
            if (curParentId !== targetFolder.id) {
                plan.panelMoves.push({ item: item, itemName: item.name, kind: "comp", targetFolder: targetFolder, fromPath: Proj.folderPathOf(item) });
            }
            checkProxyWarning(item, plan);
        });

        // ---- Footage ----
        var footageIds = ctx.graph.footageMap.keys();
        U.each(footageIds, function (idStr) {
            var item = ctx.graph.footageMap.get(idStr);
            var kind = Proj.sourceKind(item);

            if (kind === "solid") { plan.skips.push({ itemName: item.name, reason: "solid — left in place" }); return; }
            if (kind === "placeholder") { plan.skips.push({ itemName: item.name, reason: "placeholder — no file on disk" }); return; }
            if (kind === "unknown") { plan.skips.push({ itemName: item.name, reason: "unrecognized source type" }); return; }

            if (kind === "missing") {
                var missingPath = U.safe(function () { return item.mainSource.missingFootagePath; }, "");
                var extM = Fs.extOf(missingPath.split("/").pop() || "");
                var bucketM = Classify.bucketForExt(extM);
                var targetM = ctx.bucketAEFolders[bucketM.key];
                var curM = U.safe(function () { return item.parentFolder.id; }, -1);
                if (curM !== targetM.id) {
                    plan.panelMoves.push({ item: item, itemName: item.name, kind: "footage", targetFolder: targetM, fromPath: Proj.folderPathOf(item) });
                }
                plan.warnings.push(item.name + " — footage is offline (" + missingPath + "); filed by extension, not consolidated.");
                return;
            }

            // kind === "file"
            var f = Proj.itemFile(item);
            if (!f) { plan.skips.push({ itemName: item.name, reason: "no file reference" }); return; }
            var ext = Fs.extOf(Fs.baseName(f));
            var bucket = Classify.bucketForExt(ext);
            var targetAEFolder = ctx.bucketAEFolders[bucket.key];
            var curId = U.safe(function () { return item.parentFolder.id; }, -1);
            if (curId !== targetAEFolder.id) {
                plan.panelMoves.push({ item: item, itemName: item.name, kind: "footage", targetFolder: targetAEFolder, fromPath: Proj.folderPathOf(item) });
            }

            var seq = Seq.detect(item);
            var destBucketDiskFolder = ctx.bucketDiskFolders[bucket.key];
            var desiredDir = seq ? Fs.childFolder(destBucketDiskFolder, seq.base).fsName : destBucketDiskFolder.fsName;
            var alreadyCorrectDir = Fs.normPath(f.parent.fsName) === Fs.normPath(desiredDir);

            checkProxyWarning(item, plan);

            if (alreadyCorrectDir) return; // no disk op needed

            var moveNotCopy = Fs.isInside(f, ctx.projRoot);

            if (seq) {
                var destSeqFolder = Fs.childFolder(destBucketDiskFolder, seq.base);
                var reuse = false;
                if (destSeqFolder.exists) {
                    var existingFirst = Fs.child(destSeqFolder, Fs.baseName(seq.first));
                    if (existingFirst.exists && Fs.sameFile(seq.first, existingFirst)) {
                        reuse = true;
                    } else {
                        var n = 1;
                        while (destSeqFolder.exists) { n++; destSeqFolder = Fs.childFolder(destBucketDiskFolder, seq.base + "_" + n); }
                    }
                }
                var destFirstFile = Fs.child(destSeqFolder, Fs.baseName(seq.first));
                plan.diskCopies.push({
                    item: item, itemName: item.name, kind: "sequence", isSeq: true,
                    srcFiles: seq.members, destFolder: destSeqFolder, destFirstFile: destFirstFile,
                    moveNotCopy: moveNotCopy, reuse: reuse,
                    bytes: U.safe(function () { return seq.first.length * seq.members.length; }, 0)
                });
                plan.relinks.push({ item: item, isSeq: true, destFile: destFirstFile });
            } else {
                var originalName = Fs.baseName(f);
                var existingOriginal = Fs.child(destBucketDiskFolder, originalName);
                var reuseSingle = false, destFile;
                if (existingOriginal.exists && Fs.sameFile(f, existingOriginal)) {
                    reuseSingle = true;
                    destFile = existingOriginal;
                } else {
                    var destName = reserveName(destBucketDiskFolder, originalName);
                    destFile = Fs.child(destBucketDiskFolder, destName);
                }
                plan.diskCopies.push({
                    item: item, itemName: item.name, kind: "single", isSeq: false,
                    srcFiles: [f], destFolder: destBucketDiskFolder, destFile: destFile,
                    moveNotCopy: moveNotCopy, reuse: reuseSingle,
                    bytes: U.safe(function () { return f.length; }, 0)
                });
                plan.relinks.push({ item: item, isSeq: false, destFile: destFile });
            }
        });

        U.each(ctx.mainComps, function (c) { checkProxyWarning(c, plan); });

        var totalBytes = 0, copyCount = 0;
        U.each(plan.diskCopies, function (c) { if (!c.reuse) { totalBytes += c.bytes; copyCount++; } });
        plan.totals = {
            copyItems: copyCount, copyBytes: totalBytes,
            panelMoves: plan.panelMoves.length, relinks: plan.relinks.length, skips: plan.skips.length
        };
        return plan;
    }

    function buildRemovePlan(ctx, opts) {
        var plan = { kind: "remove", removals: [], skips: [], stampNumItems: ctx.stampNumItems, stampAep: ctx.stampAep };
        var protectedNames = opts.protectExpressions ? scanExpressionReferences() : U.newSet();

        var allItems = Proj.snapshotItems();
        U.each(allItems, function (item) {
            if (item instanceof FolderItem) return;
            if (!(item instanceof CompItem) && !(item instanceof FootageItem)) return;
            if (ctx.graph.reach.has(item.id)) return;
            var nameLower = U.safe(function () { return item.name.toLowerCase(); }, "");
            if (opts.protectExpressions && protectedNames.has(nameLower)) {
                plan.skips.push({ itemName: item.name, reason: "referenced by an expression — protected" });
                return;
            }
            plan.removals.push({ item: item, itemName: item.name, kind: item instanceof CompItem ? "comp" : "footage", fromPath: Proj.folderPathOf(item) });
        });

        plan.totals = { removals: plan.removals.length, skips: plan.skips.length };
        return plan;
    }

    // Pure search-and-match: every FootageItem that is currently offline gets looked up by its
    // original filename in fileIndex (built from a recursive scan of the project folder). No
    // disk I/O happens here or in Exec.runRelinkMissing — this only ever repoints AE at a file
    // that already exists, so unlike Rehouse it is safe to apply entirely inside one undo group.
    function buildRelinkMissingPlan(ctx, fileIndex) {
        var plan = { kind: "relink", relinks: [], ambiguous: [], notFound: [], stampNumItems: ctx.stampNumItems, stampAep: ctx.stampAep };
        var allItems = Proj.snapshotItems();
        U.each(allItems, function (item) {
            if (!(item instanceof FootageItem)) return;
            if (Proj.sourceKind(item) !== "missing") return;
            var missingPath = U.safe(function () { return item.mainSource.missingFootagePath; }, "");
            if (!missingPath) { plan.notFound.push({ itemName: item.name, reason: "no recorded path" }); return; }
            var basename = missingPath.replace(/\\/g, "/").split("/").pop();
            var candidates = fileIndex.get(basename.toLowerCase()) || [];
            if (candidates.length === 0) {
                plan.notFound.push({ itemName: item.name, reason: "not found under " + ctx.projRoot.fsName });
                return;
            }

            var chosen = null;
            if (candidates.length === 1) {
                chosen = candidates[0];
            } else {
                var inAssets = [];
                for (var i = 0; i < candidates.length; i++) if (Fs.isInside(candidates[i], ctx.assetsRootDisk)) inAssets.push(candidates[i]);
                if (inAssets.length === 1) chosen = inAssets[0];
            }
            if (!chosen) {
                var paths = [];
                for (var k = 0; k < candidates.length; k++) paths.push(candidates[k].fsName);
                plan.ambiguous.push({ itemName: item.name, candidates: paths });
                return;
            }

            var pattern = seqPatternForMissing(item, basename);
            if (pattern) {
                var members = gatherSequenceMembers(chosen.parent, pattern);
                if (members.length >= 2) {
                    plan.relinks.push({ item: item, isSeq: true, destFile: members[0], itemName: item.name, foundAt: chosen.parent.fsName, memberCount: members.length });
                    return;
                }
            }
            plan.relinks.push({ item: item, isSeq: false, destFile: chosen, itemName: item.name, foundAt: chosen.fsName });
        });
        plan.totals = { relinks: plan.relinks.length, ambiguous: plan.ambiguous.length, notFound: plan.notFound.length };
        return plan;
    }

    // ----------------------------------------------------------------- Exec
    // The only module allowed to mutate the project or the filesystem.

    var Exec = {
        runRehouseDisk: function (plan, progressCb) {
            var result = { failed: [], succeededItemIds: U.newSet() };
            U.each(plan.createDiskFolders, function (folder) { Fs.mkdirp(folder); });

            var totalBytes = plan.totals.copyBytes || 1, doneBytes = 0, idx = 0;
            var count = plan.diskCopies.length;

            U.each(plan.diskCopies, function (c) {
                idx++;
                if (progressCb) progressCb(doneBytes / totalBytes, "Rehousing " + c.itemName + " (" + idx + "/" + count + ")");
                if (c.reuse) { result.succeededItemIds.add(c.item.id); return; }

                if (c.kind === "single") {
                    var r = c.moveNotCopy ? Fs.moveVerified(c.srcFiles[0], c.destFile) : Fs.copyVerified(c.srcFiles[0], c.destFile);
                    if (r.ok) result.succeededItemIds.add(c.item.id);
                    else result.failed.push({ itemName: c.itemName, error: r.error });
                } else {
                    Fs.mkdirp(c.destFolder);
                    var allOk = true, lastErr = "";
                    for (var i = 0; i < c.srcFiles.length; i++) {
                        var destMember = Fs.child(c.destFolder, Fs.baseName(c.srcFiles[i]));
                        var r2 = c.moveNotCopy ? Fs.moveVerified(c.srcFiles[i], destMember) : Fs.copyVerified(c.srcFiles[i], destMember);
                        if (!r2.ok) { allOk = false; lastErr = r2.error; }
                    }
                    if (allOk) result.succeededItemIds.add(c.item.id);
                    else result.failed.push({ itemName: c.itemName, error: "sequence copy incomplete: " + lastErr });
                }
                doneBytes += c.bytes;
            });
            return result;
        },

        relinkOne: function (entry) {
            var item = entry.item;
            var savedName = U.safe(function () { return item.name; }, null);
            var snap = Interp.capture(item);
            try {
                if (entry.isSeq) item.replaceWithSequence(entry.destFile, false);
                else item.replace(entry.destFile);
            } catch (e) {
                return false;
            }
            if (savedName !== null && item.name !== savedName) U.safe(function () { item.name = savedName; });
            Interp.restore(item, snap);
            return true;
        },

        sweepEmptyFolders: function () {
            var canonical = U.newSet();
            canonical.add(CFG.panel.comps); canonical.add(CFG.panel.precomps);
            canonical.add(CFG.panel.assets); canonical.add(CFG.panel.imports);
            var folders = [];
            U.each(Proj.snapshotItems(), function (it) { if (it instanceof FolderItem) folders.push(it); });
            folders.sort(function (a, b) { return depthOf(b) - depthOf(a); });
            U.each(folders, function (f) {
                var parentIsRoot = U.safe(function () { return f.parentFolder.id === app.project.rootFolder.id; }, false);
                if (parentIsRoot && canonical.has(f.name)) return;
                var n = U.safe(function () { return f.numItems; }, -1);
                if (n === 0) { try { f.remove(); } catch (e) {} }
            });
        },

        runRehouseProject: function (plan, diskResult) {
            var result = { relinked: 0, moved: 0, errors: [] };
            app.beginUndoGroup(SCRIPT_NAME + " — Rehouse Used");
            try {
                U.each(plan.relinks, function (r) {
                    if (!diskResult.succeededItemIds.has(r.item.id)) return;
                    if (Exec.relinkOne(r)) result.relinked++;
                    else result.errors.push(r.item.name + ": relink failed");
                });
                U.each(plan.panelMoves, function (m) {
                    try { m.item.parentFolder = m.targetFolder; result.moved++; }
                    catch (e) { result.errors.push(m.itemName + ": " + e.toString()); }
                });
                Exec.sweepEmptyFolders();
            } finally {
                app.endUndoGroup();
            }
            return result;
        },

        runRemove: function (plan) {
            var result = { removed: 0, errors: [] };
            app.beginUndoGroup(SCRIPT_NAME + " — Remove Unused");
            try {
                for (var i = plan.removals.length - 1; i >= 0; i--) {
                    var r = plan.removals[i];
                    try { r.item.remove(); result.removed++; }
                    catch (e) { result.errors.push(r.itemName + ": " + e.toString()); }
                }
            } finally {
                app.endUndoGroup();
            }
            return result;
        },

        runRelinkMissing: function (plan) {
            var result = { relinked: 0, errors: [] };
            app.beginUndoGroup(SCRIPT_NAME + " — Fix Broken Links");
            try {
                U.each(plan.relinks, function (r) {
                    if (Exec.relinkOne(r)) result.relinked++;
                    else result.errors.push(r.itemName + ": relink failed");
                });
            } finally {
                app.endUndoGroup();
            }
            return result;
        }
    };

    // ------------------------------------------------------------------- UI

    function saveOpt(k, v) { try { app.settings.saveSetting(SETTINGS_SECTION, k, v ? "1" : "0"); } catch (e) {} }
    function loadOpt(k, d) {
        try { if (app.settings.haveSetting(SETTINGS_SECTION, k)) return app.settings.getSetting(SETTINGS_SECTION, k) === "1"; }
        catch (e) {}
        return d;
    }

    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", SCRIPT_NAME + " " + SCRIPT_VERSION, undefined, { resizeable: true });
        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 8;
        win.margins = 14;

        var title = win.add("statictext", undefined, SCRIPT_NAME);
        try { title.graphics.font = ScriptUI.newFont("dialog", "BOLD", 13); } catch (e) {}

        var optsPanel = win.add("panel", undefined, "Options");
        optsPanel.orientation = "column";
        optsPanel.alignChildren = ["left", "top"];
        optsPanel.margins = 10;

        var cbPrecompFolders = optsPanel.add("checkbox", undefined, "Pre comps in folders (group by main comp)");
        cbPrecompFolders.value = loadOpt("precompFolders", true);
        cbPrecompFolders.onClick = function () { saveOpt("precompFolders", cbPrecompFolders.value); };

        var cbProtectExpr = optsPanel.add("checkbox", undefined, "Protect items referenced by expressions (Remove Unused)");
        cbProtectExpr.value = loadOpt("protectExpr", true);
        cbProtectExpr.onClick = function () { saveOpt("protectExpr", cbProtectExpr.value); };

        var btnRow = win.add("group");
        btnRow.orientation = "row";
        btnRow.alignChildren = ["fill", "top"];
        var btnRehousePreview = btnRow.add("button", undefined, "Preview Rehouse Used");
        var btnRemovePreview = btnRow.add("button", undefined, "Preview Remove Unused");
        var btnRelinkPreview = btnRow.add("button", undefined, "Preview Fix Broken Links");

        var listBox = win.add("listbox", undefined, [], {
            numberOfColumns: 3, showHeaders: true,
            columnTitles: ["Action", "Item", "Details"]
        });
        listBox.alignment = ["fill", "fill"];
        listBox.minimumSize = [500, 160];
        listBox.preferredSize = [640, 260];

        var summary = win.add("statictext", undefined, "Click a Preview button to scan the project.", { multiline: true });
        summary.alignment = ["fill", "top"];

        var progressGroup = win.add("group");
        progressGroup.orientation = "row";
        progressGroup.alignChildren = ["fill", "center"];
        var progressBar = progressGroup.add("progressbar", undefined, 0, 100);
        progressBar.alignment = ["fill", "center"];
        var progressLabel = progressGroup.add("statictext", undefined, "");
        progressGroup.visible = false;

        var commitRow = win.add("group");
        commitRow.orientation = "row";
        commitRow.alignChildren = ["right", "top"];
        commitRow.alignment = ["fill", "top"];
        var btnClear = commitRow.add("button", undefined, "Clear");
        var btnApply = commitRow.add("button", undefined, "Apply");
        btnApply.enabled = false;

        var pendingPlan = null, pendingKind = null;

        function addRow(a, b, c) {
            var row = listBox.add("item", a);
            row.subItems[0].text = b;
            row.subItems[1].text = c;
        }

        function clearPreview() {
            pendingPlan = null; pendingKind = null;
            listBox.removeAll();
            btnApply.enabled = false;
            summary.text = "Click a Preview button to scan the project.";
        }

        function renderPlanRows(plan) {
            listBox.removeAll();
            if (plan.kind === "rehouse") {
                U.each(plan.createDiskFolders, function (f) { addRow("MKDIR", "—", f.fsName); });
                U.each(plan.diskCopies, function (c) {
                    var action = c.reuse ? "DEDUPE" : (c.moveNotCopy ? "MOVE" : "COPY");
                    var label = c.kind === "sequence" ? (action + " ×" + c.srcFiles.length) : action;
                    var detail = c.reuse
                        ? "identical file already in place → relink only"
                        : ("→ " + c.destFolder.fsName + " (" + U.fmtBytes(c.bytes) + ")");
                    addRow(label, c.itemName, detail);
                });
                U.each(plan.relinks, function (r) { addRow("RELINK", r.item.name, "→ " + r.destFile.fsName); });
                U.each(plan.panelMoves, function (m) {
                    addRow("PANEL", m.itemName, (m.fromPath || "(root)") + "  →  " + Proj.folderFullPath(m.targetFolder));
                });
                U.each(plan.skips, function (s) { addRow("SKIP", s.itemName, s.reason); });
                U.each(plan.warnings, function (w) { addRow("WARN", "", w); });
                summary.text = plan.mainCompCount + " main comp(s) found. " +
                    plan.totals.copyItems + " to copy/move (" + U.fmtBytes(plan.totals.copyBytes) + "), " +
                    plan.totals.relinks + " relinks, " + plan.totals.panelMoves + " panel moves, " +
                    plan.totals.skips + " skipped.";
            } else if (plan.kind === "remove") {
                U.each(plan.removals, function (r) { addRow("REMOVE", r.itemName, r.kind + " — " + (r.fromPath || "(root)")); });
                U.each(plan.skips, function (s) { addRow("SKIP", s.itemName, s.reason); });
                summary.text = plan.totals.removals + " item(s) will be removed from the project panel. Nothing on disk is touched.";
            } else if (plan.kind === "relink") {
                U.each(plan.relinks, function (r) {
                    var label = r.isSeq ? ("FOUND ×" + r.memberCount) : "FOUND";
                    addRow(label, r.itemName, "→ " + r.foundAt);
                });
                U.each(plan.ambiguous, function (a) {
                    addRow("AMBIGUOUS", a.itemName, a.candidates.length + " matches, resolve manually: " + a.candidates.join("  |  "));
                });
                U.each(plan.notFound, function (n) { addRow("NOT FOUND", n.itemName, n.reason); });
                summary.text = plan.totals.relinks + " link(s) will be fixed, " + plan.totals.ambiguous + " ambiguous (skipped), " + plan.totals.notFound + " not found anywhere in the project folder.";
            }
            btnApply.enabled = (plan.kind === "rehouse")
                ? (plan.diskCopies.length + plan.relinks.length + plan.panelMoves.length + plan.createDiskFolders.length) > 0
                : (plan.kind === "remove" ? plan.removals.length > 0 : plan.relinks.length > 0);
        }

        btnRehousePreview.onClick = function () {
            try {
                var ctx = buildContext();
                if (ctx.error) { alert(ctx.error); return; }
                var plan = buildRehousePlan(ctx, { precompFolders: cbPrecompFolders.value });
                pendingPlan = plan; pendingKind = "rehouse";
                renderPlanRows(plan);
            } catch (e) {
                alert(SCRIPT_NAME + " error while scanning:\n" + e.toString());
            }
        };

        btnRemovePreview.onClick = function () {
            try {
                var ctx = buildContext();
                if (ctx.error) { alert(ctx.error); return; }
                var plan = buildRemovePlan(ctx, { protectExpressions: cbProtectExpr.value });
                pendingPlan = plan; pendingKind = "remove";
                renderPlanRows(plan);
            } catch (e) {
                alert(SCRIPT_NAME + " error while scanning:\n" + e.toString());
            }
        };

        btnRelinkPreview.onClick = function () {
            try {
                var ctx = buildContext();
                if (ctx.error) { alert(ctx.error); return; }
                var fileIndex = Locate.buildFileIndex(ctx.projRoot, [ctx.rendersDisk]);
                var plan = buildRelinkMissingPlan(ctx, fileIndex);
                pendingPlan = plan; pendingKind = "relink";
                renderPlanRows(plan);
            } catch (e) {
                alert(SCRIPT_NAME + " error while scanning:\n" + e.toString());
            }
        };

        btnClear.onClick = clearPreview;

        btnApply.onClick = function () {
            if (!pendingPlan) return;
            var aepNow = app.project.file ? app.project.file.fsName : null;
            if (pendingPlan.stampNumItems !== app.project.numItems || pendingPlan.stampAep !== aepNow) {
                alert("The project changed since the preview. Please preview again.");
                clearPreview();
                return;
            }
            btnApply.enabled = false;
            try {
                if (pendingKind === "rehouse") {
                    progressGroup.visible = true;
                    var diskResult = Exec.runRehouseDisk(pendingPlan, function (frac, label) {
                        progressBar.value = Math.round(frac * 100);
                        progressLabel.text = label;
                        U.safe(function () { win.layout.layout(true); }, null);
                    });
                    progressGroup.visible = false;
                    var projResult = Exec.runRehouseProject(pendingPlan, diskResult);
                    var msg = "Rehouse complete.\n\n" +
                        "Copied/moved: " + diskResult.succeededItemIds.size() + "\n" +
                        "Relinked: " + projResult.relinked + "\n" +
                        "Panel moves: " + projResult.moved;
                    if (diskResult.failed.length) {
                        msg += "\n\nFailed (" + diskResult.failed.length + "):\n";
                        U.each(diskResult.failed, function (f) { msg += "- " + f.itemName + ": " + f.error + "\n"; });
                    }
                    if (projResult.errors.length) {
                        msg += "\n\nProject errors (" + projResult.errors.length + "):\n";
                        U.each(projResult.errors, function (e) { msg += "- " + e + "\n"; });
                    }
                    alert(msg);
                } else if (pendingKind === "remove") {
                    var remResult = Exec.runRemove(pendingPlan);
                    var msg2 = "Removed " + remResult.removed + " item(s) from the project panel.\nNo files were touched on disk.";
                    if (remResult.errors.length) {
                        msg2 += "\n\nErrors:\n";
                        U.each(remResult.errors, function (e) { msg2 += "- " + e + "\n"; });
                    }
                    alert(msg2);
                } else if (pendingKind === "relink") {
                    var relResult = Exec.runRelinkMissing(pendingPlan);
                    var msg3 = "Fixed " + relResult.relinked + " broken link(s).\nNo files were touched on disk.";
                    if (relResult.errors.length) {
                        msg3 += "\n\nErrors:\n";
                        U.each(relResult.errors, function (e) { msg3 += "- " + e + "\n"; });
                    }
                    alert(msg3);
                }
            } catch (e) {
                alert(SCRIPT_NAME + " error while applying:\n" + e.toString());
            } finally {
                clearPreview();
            }
        };

        win.onResizing = win.onResize = function () { this.layout.resize(); };

        if (win instanceof Window) { win.center(); win.show(); }
        else { win.layout.layout(true); win.layout.resize(); }

        return win;
    }

    buildUI(thisObj);

})(this);
