---
version: 1
slug: "frontend-src-app-tsx"
primary_target: "frontend/src/app.tsx"
related_targets: ["frontend/src/styles.css"]
---

# Repository workspace

Mode: Operate. Target: frontend/src/app.tsx and frontend/src/styles.css.

## Direction contract

THESIS: A read-only repository workspace with fixed files, preview, changes, and history panes. The supplied sketch determines their order and proportions.

OWN-WORLD: The user chose white surfaces, fine neutral rules, and one blue selection background. Git changes color names amber for modifications, green for additions, a lighter desaturated green for untracked files, and red for deletions and conflicts. Unchanged names use a slightly muted gray. Folders inherit changes from descendants; selection preserves name colors. The file tree uses current working-tree decorations only when viewing HEAD or the checked-out branch. System UI typography and monospace source text keep the workspace familiar.

STORY: Choose a branch on the left, expand folders in place, open a file, then inspect local changes or a historical commit from the right. At HEAD or the checked-out branch, the file tree includes untracked and new local files and directories; it opens working-tree content and keeps removed files visible with their original content and a removal label. Source and diff previews have syntax highlighting and a fixed left gutter. Source markers compare the working tree against HEAD or the selected commit against its first parent. Source starts directly below the heading. Diff metadata is omitted; multiple files retain their names as separators. Local changes appear under Tracked and Untracked as compact folder trees. Tracked rows show additions and deletions, with S for staged entries and ! for conflicts. While viewing a commit, Changes lists its complete diff against the first parent under Commit, preserving the list when individual files or diffs are opened. Returning to a branch or HEAD restores local changes. Commit changes have no refresh action. Each row opens its own diff; there is no content button. Updating local changes fetches status and statistics, preserving the preview and navigation and updating local entries within expanded folders. GET-only APIs and read-only behavior remain intact. UI copy is English; repository contents remain verbatim.

FIRST VIEWPORT: Four fixed columns: 200px files, a flexible preview of at least 300px, 280px changes, and 230px history. 44px headings, 24px tree rows, and independently scrolling bodies. A 28px footer spans the viewport and shows the repository path and HEAD or commit position. Branch names appear only in the selector. The document never scrolls vertically. Only the workspace pans horizontally on narrow screens. Content growth never moves pane boundaries.

FORM: The user-pinned editor workspace overrides direction seed 8cc9b346. The supplied wireframe is the composition reference. Signature interaction: a file selection replaces the contents of one viewer without moving any column. Its fixed, full-width heading shows the item name and a close button at the right edge. Before an item is opened, the heading remains empty.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
