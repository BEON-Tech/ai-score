import { spawn } from "node:child_process";

/**
 * Best-effort browser launch. The URL is always printed by the caller too, so a
 * failure here is cosmetic: the engineer can still paste it. Returns whether
 * the launcher was spawned, not whether a browser actually appeared.
 */
export function openBrowser(url: string): boolean {
  const [command, args] = launcher(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function launcher(url: string): [string, string[]] {
  switch (process.platform) {
    case "darwin":
      return ["open", [url]];
    case "win32":
      // `start` is a cmd builtin; the empty string is the (required) window
      // title, without which a quoted URL would be read as the title.
      return ["cmd", ["/c", "start", "", url]];
    default:
      return ["xdg-open", [url]];
  }
}

/**
 * Whether launching a browser could plausibly work. Headless CI and most SSH
 * sessions have no display, and spawning there just prints noise.
 */
export function canOpenBrowser(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);
}
