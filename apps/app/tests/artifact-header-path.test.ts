import { expect, test } from "bun:test";

import { artifactHeaderPath } from "../src/react-app/domains/session/artifacts/artifact-panel";
import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";

function target(value: string, name = value.split("/").pop() ?? value, kind: OpenTarget["kind"] = "file"): OpenTarget {
  return { id: `${kind}:${value}`, kind, value, name, preview: "text", confidence: 1, reason: "test" };
}

test("the panel header shows where a nested file lives", () => {
  // The tab label is only the basename; the header carries the full path.
  expect(artifactHeaderPath(target("apps/app/src/main.tsx"))).toBe("apps/app/src/main.tsx");
  expect(artifactHeaderPath(target("docs/guides/setup.md"))).toBe("docs/guides/setup.md");
});

test("the header never repeats the name for a file at the workspace root", () => {
  expect(artifactHeaderPath(target("README.md", "README.md"))).toBe("");
});

test("a Windows path is shown with forward slashes", () => {
  expect(artifactHeaderPath(target("docs\\guides\\setup.md", "setup.md"))).toBe("docs/guides/setup.md");
});

test("a leading ./ and a trailing / are trimmed", () => {
  expect(artifactHeaderPath(target("./src/app.tsx", "app.tsx"))).toBe("src/app.tsx");
  expect(artifactHeaderPath(target("docs/guides/", "guides"))).toBe("docs/guides");
  // A directory-like root name is still nothing to add.
  expect(artifactHeaderPath(target("docs/", "docs"))).toBe("");
});

test("URLs keep their full address", () => {
  const url = target("https://omnirush.ai/docs/quick-start?x=1", "quick-start", "url");
  expect(artifactHeaderPath(url)).toBe("https://omnirush.ai/docs/quick-start?x=1");
});
