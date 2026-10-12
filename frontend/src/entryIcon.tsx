import { flavors } from "@catppuccin/palette";
import { icons } from "@iconify-json/catppuccin";
import { addCollection, Icon } from "@iconify/react/offline";
import { findFileIcon } from "find-file-icon/catppuccin";

import type { TreeEntry } from "./fileTree";

// Iconify distributes Macchiato colors; use the matching Latte colors on our light surfaces.
const colors = new Map(
  flavors.macchiato.colorEntries.map(([name, color]) => [
    color.hex,
    flavors.latte.colors[name].hex,
  ]),
);
const artwork = Object.fromEntries(
  Object.entries(icons.icons).map(([name, icon]) => [
    name,
    {
      ...icon,
      body: icon.body.replace(/#[\da-f]{6}/gi, (color) => colors.get(color) ?? color),
    },
  ]),
);
addCollection({ ...icons, icons: artwork });

export default function EntryIcon({
  name,
  kind,
  expanded = false,
}: {
  name: string;
  kind: TreeEntry["kind"];
  expanded?: boolean;
}) {
  let iconName: string;
  if (kind === "symlink") iconName = "catppuccin:symlink";
  else if (kind === "submodule") iconName = "catppuccin:folder-git";
  else if (kind === "tree") {
    const folder = findFileIcon(name, "folder");
    iconName = expanded ? folder.expandedName : folder.name;
  } else iconName = findFileIcon(name, "file").name;

  const key = iconName.slice("catppuccin:".length);
  if (!artwork[key] && !icons.aliases?.[key]) {
    throw new Error(`Missing Catppuccin icon: ${iconName}`);
  }
  return (
    <Icon
      icon={iconName}
      className="entry-icon"
      data-expanded={kind === "tree" ? expanded : undefined}
      aria-hidden="true"
      width={16}
      height={16}
    />
  );
}
