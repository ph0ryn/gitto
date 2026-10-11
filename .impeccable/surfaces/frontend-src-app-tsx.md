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

OWN-WORLD: The user chose white surfaces, fine neutral rules, and one blue selection color. System UI typography and monospace source text keep the workspace familiar.

STORY: Choose a branch on the left, open a file, then inspect local changes or a historical commit from the right. Updating changes re-fetches only status and preserves the preview and navigation. Existing GET APIs and read-only behavior remain intact.

FIRST VIEWPORT: Four fixed columns: 200px files, a flexible preview of at least 300px, 210px changes, and 230px history. 44px headings and independently scrolling bodies. A 28px footer spans the viewport and shows the repository path and HEAD or commit position. Branch names appear only in the selector. The document never scrolls vertically. Only the workspace pans horizontally on narrow screens. Content growth never moves pane boundaries.

FORM: The user-pinned editor workspace overrides direction seed 8cc9b346. The supplied wireframe is the composition reference. Signature interaction: a file selection replaces one closable preview tab without moving any column. No tab is shown before an item is opened.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
