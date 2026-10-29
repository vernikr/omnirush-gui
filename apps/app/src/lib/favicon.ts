/**
 * Paper rule "Pasted links get favicons": any http(s) URL in user or
 * assistant text renders with the site's favicon next to it.
 *
 * Variant A — theme-aware GitHub icon (fork vernikr/omnirush-gui):
 * - github.com (+ *.github.com) → https://github.githubassets.com/favicons/favicon(-dark).png
 *   with live dark/light switch, transparent background, no white square.
 * - every other host → https://icon.horse/icon/<host> (preserves transparency,
 *   unlike Google S2 which flattens to white). No per-host dark variant exists
 *   for arbitrary domains; the transparent PNG lets the surrounding dark/light
 *   chat background show through.
 */

export function isGitHubHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === "github.com" || h.endsWith(".github.com")
}

export function githubFaviconUrl(isDark: boolean): string {
  return isDark
    ? "https://github.githubassets.com/favicons/favicon-dark.png"
    : "https://github.githubassets.com/favicons/favicon.png"
}

function getIsDark(): boolean {
  if (typeof document !== "undefined") {
    const themed = document.documentElement?.dataset?.theme
    if (themed === "dark") return true
    if (themed === "light") return false
    if (document.documentElement?.classList?.contains("dark")) return true
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
    } catch {
      // ignore
    }
  }
  return false
}

export function faviconUrlForHref(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (!url.hostname || url.hostname === "localhost") return null
    if (isGitHubHost(url.hostname)) {
      watchFaviconTheme()
      return githubFaviconUrl(getIsDark())
    }
    return `https://icon.horse/icon/${encodeURIComponent(url.hostname)}`
  } catch {
    return null
  }
}

/**
 * Update already-rendered GitHub favicon <img> elements when the theme flips.
 * Markdown is rendered to static HTML, so without this a theme toggle would
 * only affect the next message.
 */
export function syncFaviconTheme(root: ParentNode = document): void {
  if (typeof document === "undefined") return
  const isDark = getIsDark()
  const expected = githubFaviconUrl(isDark)
  for (const img of (root as Document | Element).querySelectorAll<HTMLImageElement>(
    'img[data-omnirush-favicon="github"]',
  )) {
    // Avoid churn if already correct; also handles <img> that was server-rendered
    // before the observer was attached.
    if (img.src !== expected) img.src = expected
  }
}

// Install the document listeners on first renderer mount rather than module
// import. This keeps server rendering and pure string-rendering tests free of
// global DOM side effects.
let faviconThemeWatchStarted = false;

export function watchFaviconTheme(): void {
  if (faviconThemeWatchStarted || typeof window === "undefined" || typeof document === "undefined") return;
  faviconThemeWatchStarted = true;
  try {
    const mo = new MutationObserver(() => syncFaviconTheme());
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
  } catch {
    // jsdom / old env
  }
  try {
    window
      .matchMedia?.("(prefers-color-scheme: dark)")
      ?.addEventListener?.("change", () => syncFaviconTheme());
  } catch {
    // Safari <14
    try {
      window
        .matchMedia?.("(prefers-color-scheme: dark)")
        ?.addListener?.(() => syncFaviconTheme());
    } catch {
      // ignore
    }
  }
}
