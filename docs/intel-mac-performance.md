# Why a thinking run used to burn a core, and what changed

A run that only *thinks* — `Reasoning trace…`, no tool calls, no answer text
yet — used to push an Intel Mac's CPU to a constant high load for as long as
the model kept reasoning, with the app completely idle the rest of the time.
This note records what caused it, what this fork changed, and how to check the
change on a real machine.

## What was happening

Three costs stacked up, all of them proportional to *how much the model has
written so far*, and all of them paid on every animation frame.

### 1. The reasoning trace rendered as markdown on every frame

`ReasoningBlock` documented "collapsed by default" but opened itself with
`useState(true)`, so the whole trace was live markdown from the first token.

`createStreamingMarkdownRenderer` keeps the previous frame's top-level blocks
and re-lexes only the last `STREAMING_RELEX_TAIL = 2` of them. That works when
an answer is a sequence of short blocks. Reasoning is usually **one paragraph**,
so the tail window collapses to that single block and every frame re-runs the
full path: lexer → inline parse → DOMPurify → `innerHTML` replacement → layout.
Rendering a single growing paragraph is linear in the trace, which makes
streaming it quadratic over the turn.

Measured with the app's own parser (`bun`, no DOM, so DOMPurify is inert and
the real numbers are *worse*):

| trace length | one render |
| --- | --- |
| 4 KB | 3.8 ms |
| 8 KB | 6.4 ms |
| 16 KB | 13.5 ms |
| 32 KB | 26 ms |
| 64 KB | 55 ms |

At 60 frames per second a 16 KB trace already asks for ~80 % of a core just to
parse its own markdown, and it keeps climbing. A simulated 90-second reasoning
stream (216 KB of one paragraph) spent **407 CPU-seconds** rendering, i.e. more
than four cores' worth per second of wall clock — the renderer simply cannot
keep up, every frame is late, and the machine stays pinned until the model
stops. Note the same text split into many blocks costs 0.4–1.7 ms per render:
the block shape, not the length, is what explodes.

### 2. The transcript progress fingerprint re-hashed the whole trace

`transcriptProgress` runs after every coalesced flush (once per frame while a
turn streams). Its object-identity cache cannot hit for the part that is still
growing, because the flush rebuilds that part object every frame — so it
`JSON.stringify`-ed the entire text and walked every character in an FNV loop.
Same quadratic shape, smaller constant: 170 ms of pure hashing for a
90-second trace, against 1.3 ms after the fix.

### 3. The window-sized backdrop blur, twice per frame

The session pane carries the app's only `backdrop-blur-2xl`
(`chat/session-page.tsx`). macOS windows here are transparent
(`backgroundColor: #00000001`) with a vibrancy material behind them, so the
backdrop is the *native* window material: Chromium has to sample it and run the
filter every time the pane is recomposited. Upstream already knows this — the
`<main>` element carries a comment saying a second backdrop filter "forces an
extra full-pane blur pass every frame the transcript repaints".

While a run is live the transcript repaints continuously (streaming text, the
`ow-text-shimmer` working lines, the paused dots), so that pass runs at frame
rate for the whole turn. On Apple Silicon it is invisible; on Intel's iGPU a
40 px blur over a full window is the most expensive frame operation the app
performs, and it shows up as GPU-process CPU time.

That is also why the load appeared only while the agent worked: at rest nothing
animates, the pane is not recomposited, and no blur runs.

## What changed

| | where |
| --- | --- |
| Reasoning is collapsed by default, and a closed panel keeps its markdown out of the tree entirely | `apps/app/src/components/chat/reasoning-block.tsx` |
| Streaming markdown is paced against its own measured cost instead of the token rate | `apps/app/src/components/markdown/use-streaming-render-pace.ts`, `markdown.tsx` |
| Progress fingerprint is O(1) per flush (length + 32-char tail) | `apps/app/src/react-app/domains/session/status/session-progress.ts` |
| Intel macOS builds drop the pane's backdrop blur; every build honours the system "Reduce transparency" setting | `apps/app/src/app/index.css`, `preload.mjs` (`omnirush-platform-mac-intel`) |

The pacing rule: below 2 KB a block still renders on every frame, exactly as
before. Above it, the next publish happens after
`max(80 ms, lastRenderCost / 0.1)` — the renderer may spend about a tenth of a
core on itself and no more, so the period stretches as the block grows: ~12
updates per second at 10 KB, ~1 per second at 60 KB. The text is never dropped
or reordered; when the stream ends the full text is rendered immediately.

Same 90-second simulation as above, with the pacer:

| strategy | renders | render CPU | per second of streaming |
| --- | --- | --- | --- |
| every frame (before) | 4 479 | 407 s | 4 517 ms |
| fixed 12.5 Hz | 1 080 | 102 s | 1 130 ms |
| measured-cost pacing at 10 % of a core (after) | 192 | 8.9 s | 99 ms |

And with the trace collapsed — the default — the number is zero: nothing is
parsed while the panel is closed, no matter how much the model writes.

## How to verify on a machine

1. Open a session, send a prompt that makes the model think for a while
   (a hard question or a large repo task).
2. Activity Monitor → CPU, grouped by process, during the reasoning phase.
   Before: `OmniRush Helper (Renderer)` plus `OmniRush Helper (GPU)` climbing to
   a large share of the machine. After: both largely quiet, with `opencode`
   (the engine itself) left as the main consumer.
3. Expand `Reasoning trace…` mid-run to see the paced path: the trace updates a
   few times per second, the CPU stays low.
4. For an A/B on the blur alone: System Settings → Accessibility → Display →
   Reduce transparency. That now removes the pane blur on any Mac as well, so
   toggling it isolates the compositor cost from the parser cost.
   `ELECTRON_ENABLE_LOGGING=1` plus Chrome DevTools (Performance panel, port
   9223–9227) shows `Recalculate Style`, `Layout`, `marked` lexer frames and the
   GPU process' `Compositing` rows.
