// A right-click menu for the editor. Only one is open at a time.

let openMenu = null;

export function closeContextMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  window.removeEventListener("mousedown", onOutsideMouseDown, true);
  window.removeEventListener("keydown", onMenuKeyDown, true);
  window.removeEventListener("blur", closeContextMenu);
  window.removeEventListener("resize", closeContextMenu);
}

function onOutsideMouseDown(e) {
  if (!openMenu?.contains(e.target)) closeContextMenu();
}

function onMenuKeyDown(e) {
  if (e.key === "Escape") {
    closeContextMenu();
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * Shows a menu at (x, y). Each item is { label, key?, disabled?, run }, or null
 * for a separator.
 */
export function showContextMenu(view, x, y, items) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  for (const item of items) {
    if (!item) {
      menu.append(Object.assign(document.createElement("div"), { className: "context-menu-sep" }));
      continue;
    }
    const button = document.createElement("button");
    button.disabled = !!item.disabled;
    button.append(Object.assign(document.createElement("span"), { textContent: item.label }));
    if (item.key) {
      button.append(Object.assign(document.createElement("span"), { className: "context-menu-key", textContent: item.key }));
    }
    button.addEventListener("click", () => {
      closeContextMenu();
      item.run();
      view.focus();
    });
    menu.append(button);
  }
  document.body.append(menu);

  // Keep the menu inside the window.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width - 4))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height - 4))}px`;

  openMenu = menu;
  window.addEventListener("mousedown", onOutsideMouseDown, true);
  window.addEventListener("keydown", onMenuKeyDown, true);
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);
}
