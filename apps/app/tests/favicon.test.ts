import { describe, expect, test } from "bun:test";

import { faviconUrlForHref, githubFaviconUrl, isGitHubHost } from "../src/lib/favicon";

describe("Markdown favicons", () => {
  test("recognizes GitHub hosts without accepting lookalike suffixes", () => {
    expect(isGitHubHost("github.com")).toBe(true);
    expect(isGitHubHost("docs.github.com")).toBe(true);
    expect(isGitHubHost("github.com.example.org")).toBe(false);
  });

  test("uses transparent GitHub assets for both themes", () => {
    expect(githubFaviconUrl(false)).toBe("https://github.githubassets.com/favicons/favicon.png");
    expect(githubFaviconUrl(true)).toBe("https://github.githubassets.com/favicons/favicon-dark.png");
  });

  test("uses a transparent icon service for other hosts and ignores unsafe URLs", () => {
    expect(faviconUrlForHref("https://example.org/path")).toBe("https://icon.horse/icon/example.org");
    expect(faviconUrlForHref("http://localhost:5173/")).toBeNull();
    expect(faviconUrlForHref("javascript:alert(1)")).toBeNull();
  });
});
