export type TextMatch = { start: number; end: number };

export function captureArtifactFindShortcut(
  event: KeyboardEvent,
  panel: HTMLElement,
  isMac: boolean,
  openFind: () => void,
): boolean {
  const modifier = isMac ? event.metaKey : event.ctrlKey;
  if (!modifier || event.shiftKey || event.altKey || event.key.toLowerCase() !== "f") return false;
  if (!(event.target instanceof Node) || !panel.contains(event.target)) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  openFind();
  return true;
}

export function findMatchOffsets(text: string, query: string): TextMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const matches: TextMatch[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const start = haystack.indexOf(needle, from);
    if (start < 0) break;
    matches.push({ start, end: start + needle.length });
    from = start + needle.length;
  }
  return matches;
}

const BLOCK_SELECTOR = "p,li,blockquote,pre,td,th,h1,h2,h3,h4,h5,h6,dt,dd";
const IGNORE_SELECTOR = "script,style,button,input,textarea,select,[aria-hidden='true']";

export function findTextRanges(root: HTMLElement, query: string): Range[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.textContent ?? "";
      const parent = node.parentElement;
      return text.length && parent && !parent.closest(IGNORE_SELECTOR)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const segments: Array<{ node: Text; start: number; end: number }> = [];
  let flattened = "";
  let previousBlock: Element | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const block = textNode.parentElement?.closest(BLOCK_SELECTOR) ?? textNode.parentElement;
    if (segments.length && block !== previousBlock) flattened += " ";
    const start = flattened.length;
    flattened += textNode.data;
    segments.push({ node: textNode, start, end: flattened.length });
    previousBlock = block;
  }

  const resolve = (offset: number) => segments.find((segment) => offset >= segment.start && offset < segment.end);
  return findMatchOffsets(flattened, query).flatMap(({ start, end }) => {
    const first = resolve(start);
    const last = resolve(end - 1);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return [range];
  });
}

export function setArtifactFindHighlights(ranges: Range[], activeIndex: number): void {
  const highlightApi = (window as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
    CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } };
  });
  const registry = highlightApi.CSS?.highlights;
  const HighlightConstructor = highlightApi.Highlight;
  if (!registry || !HighlightConstructor) return;

  registry.delete("omnirush-artifact-find-match");
  registry.delete("omnirush-artifact-find-active");
  const active = ranges.length ? ((activeIndex % ranges.length) + ranges.length) % ranges.length : -1;
  const others = ranges.filter((_range, index) => index !== active);
  if (others.length) registry.set("omnirush-artifact-find-match", new HighlightConstructor(...others));
  if (active >= 0) registry.set("omnirush-artifact-find-active", new HighlightConstructor(ranges[active]));
}

export function clearArtifactFindHighlights(): void {
  const registry = (window as unknown as {
    CSS?: { highlights?: { delete(name: string): void } };
  }).CSS?.highlights;
  registry?.delete("omnirush-artifact-find-match");
  registry?.delete("omnirush-artifact-find-active");
}
