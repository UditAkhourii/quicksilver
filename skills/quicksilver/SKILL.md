---
name: quicksilver
description: Offload bulk judgment calls to Jev (TypeSafe's fast System One model) so Claude doesn't read, and pay for, content it only needs a verdict on. Use this BEFORE reading many files, long logs, or big lists just to decide which parts matter. That covers finding which files relate to a feature or bug, filtering log lines for errors, triaging or labelling many items (tickets, test failures, commits, TODOs, search hits), ranking candidates by relevance, locating the right lines in a huge file, or a yes/no check on a large document. Also use when the user says quicksilver, jev, "save tokens", "delegate", or "cheaper/faster". Skip it for generation, editing, multi-step reasoning, math, counting, or date comparison, and when the input is small enough to just read.
---

# Quicksilver: let Jev make the calls, Claude does the thinking

Jev returns **typed judgments** (yes/no probability, one-of-N label, rubric score)
in about a second, at $0.042 per million input tokens. It cannot write text or reason in
steps. So the split is simple: **Jev narrows, Claude reads only what survives.**
Every item Jev rules out is content that never enters Claude's context. That
saves tokens, saves usage limits, and cuts wall-clock time, because Jev scans
hundreds of items in parallel.

In the commands below, `qs` stands for:

```bash
node "<base directory of this skill>/scripts/qs.mjs"
```

Needs Node 18+ (globs need Node 22+). There are no other dependencies.

## OpenRouter route (optional)

The default route is the vendor's (`api.typesafe.ai`, key from `JEV_API_KEY`, `TYPESAFE_API_KEY` or `~/.quicksilver/config.json`). To send the same requests through OpenRouter instead, one key for several models:

- Enable it per call with `--route openrouter`, or for the session with `QS_ROUTE=openrouter`.
- The key is read by name from `OPENROUTER_API_KEY` in the environment; it is never printed or saved. `setup` refuses on this route, and `status --route openrouter` checks the key against OpenRouter.
- The model defaults to `typesafe/jev-1.13`; override with `--model`, `QS_MODEL` or `QUICKSILVER_MODEL`.
- The OpenRouter account must allow the `typesafe` provider in its privacy settings, otherwise the call returns 404 "No allowed providers".

## First run: set the key once

Run `qs status` first.

- `ready` means go straight to the task.
- `not configured` means ask the user for their Jev API key, and point them to
  **https://console.typesafe.ai** to create one. They can:
  1. paste it in chat. Then run `qs setup <KEY>` (it verifies the key, then
     saves it to `~/.quicksilver/config.json`, user-only permissions), **or**
  2. keep it out of the chat by running `node "<skill dir>/scripts/qs.mjs" setup`
     in their own terminal. It prompts for the key with hidden input.

  `JEV_API_KEY` or `TYPESAFE_API_KEY` in the environment also works, and takes precedence.
  After setup, carry on with the original task. Don't stop at "configured".

Exit code 3 means a key problem: missing, or rejected by Jev. Re-run setup.

## When to delegate

Ask: *"Am I about to read a lot of content only to decide which parts matter?"*
If yes, and each decision fits yes/no, pick-a-label, or rate-on-a-scale, delegate.

| Situation | Command |
| --- | --- |
| "Which files deal with X?" across a repo | `qs filter "Does this file implement or handle X?" src` |
| Errors or anomalies in a big log | `qs filter "Does this line indicate a failure?" app.log --lines` |
| Where in a 5k-line file is Y? | `qs find "Y" big_file.py --top 5` |
| Sort 200 tickets, test failures, or TODOs into buckets | `qs classify --labels "bug,feature,question" --items items.jsonl` |
| Best candidates for a query (search hits, docs, files) | `qs rank "query" docs/ --top 10` |
| One yes/no over a large document | `qs ask "Does this contract allow termination without notice?" --state @contract.txt` |
| Several questions over the same content | `qs ask spec.json` (raw request, see below) |

**Benchmarked strengths** (12 real tasks, see the repo's `bench/`): Quicksilver matched Claude's
accuracy while cutting its tokens by 77–96% on needle-in-haystack log search, finding
files across a repo, "where is X?" ranking, semantic search inside huge files, and bulk
routing or classification with clear labels (support intents, CI failure causes,
sentiment). It was weaker on subjective or expert-defined labels (commit types, alert
policies) and on look-alike code (safe vs vulnerable twins). There, use its output as a
shortlist, and check the `?` items yourself.

**Don't delegate:**
- Tiny inputs (a few files, or under ~2k tokens). Just read them.
- Exact matches. `grep` or `rg` is free and exact. Jev is for *meaning*: "handles
  auth" rather than the literal string `auth`.
- Arithmetic, counting, date or time comparison. Do those in code.
- Anything generative (writing, summarizing, editing) or needing a chain of reasoning.
- Content the user wouldn't want sent to a third-party API. Quicksilver already
  skips `.env*`, keys, certs, and credentials files, and respects `.gitignore`.

## Commands

**Inputs** (for filter, classify, rank): files, directories (respects
`.gitignore` inside git repos, and skips `node_modules`, `dist`, and similar),
globs, `-` for stdin, or `--items FILE.jsonl` (one JSON object per line with
`id` and `text`, or plain text lines). Add `--lines` to judge each line
separately (logs, CSVs, lists). Use `--ext ts,tsx` to limit file types.

```bash
qs filter "<yes/no question>" <inputs> [--threshold 0.5] [--lines]
qs classify --labels "a,b,c" <inputs> [--question "..."] [--only a] [--min-confidence 0.6]
qs classify --labels-json '{"bug":"Something is broken","feature":"A request for new behaviour"}' <inputs>
qs rank "<query>" <inputs> [--top 10 | --all]
qs find "<what you're looking for>" <files> [--top 5]
qs ask "<question>" --state @file|"text"|- [--choice "a,b,c" | --score "low|mid|high"]
qs ask spec.json        # {"state": ..., "questions": {"id": {"type": "noul|choice|score", ...}}}
qs status               # key check, plus lifetime tokens saved
```

Add `--json` to any command for machine-readable output. Summary lines go to stderr.
`--save FILE` writes every per-item result to FILE, while stdout stays compact.
`--fast` packs small items into shared requests. It's about 10× faster on big logs, but
less accurate on subtle judgments. Use it for obvious needles (crashes, OOMs) in very
large logs, not for classification.

## Reading the output

Output is compact on purpose. For **filter**, each line is a probability, then the item.
With `--lines`, repeated log lines that differ only in numbers or ids are merged into
one pattern, followed by the matching line numbers:

```
0.99  src/db.ts
0.98  app.log:813  worker ERROR process killed: JavaScript heap out of memory
0.97  ×57  app.log:104  RAS KERNEL FATAL data TLB error interrupt
        also lines 115,121-130,…
? borderline (0.35–0.65) — check these yourself:
0.55  app/api/convert_safe.ts
— 340 scanned · 3 matched · 1 borderline · 4.1s · jev 90k tok ($0.0038) · ~88k Claude tokens not read
```

**classify** prints the count per label, then the ids in each label. After that it lists
each low-confidence item with its runner-up label and its text:

```
bug 41 · feature 12 · question 7
[bug] T1 T4 T9 …
? low confidence — check these yourself:
?0.49  bug (or question)  T33  login button does nothing on Safari?
```

- `?` marks a borderline or low-confidence item. **Read those yourself.** In the
  benchmark, the false positives sat in this band. Treat everything else as a
  reliable shortlist.
- `~` after an item means it was truncated past `--max-chars` (default 60k chars),
  so Jev only saw the start.
- The footer shows cost and the estimated Claude tokens avoided. Mention the
  savings to the user when they're meaningful.
- Jev's verdicts make a **shortlist, not proof**. Open the survivors before you
  edit code, draw conclusions, or tell the user something is definitely absent.
  If a filter returns nothing you expected to find, rephrase the question or
  lower `--threshold` before concluding.

## Writing good questions

Jev reads questions **literally**. Its accuracy comes from how precise the question is.

- One judgment per question. Say "Does this file send email?", not "Does this file
  send email or handle billing?". Run two filters instead.
- Spell out the exact condition, including the boundary cases: "Does this line
  report a failure (ERROR, FATAL, crash, timeout). Not warnings about deprecation?"
- Use plain meaning, not jargon hops or double negatives.
- Give classify labels short descriptions with `--labels "bug:Something broken,feature:New behaviour request"`.
  Add a catch-all label such as `other` when nothing may fit.
- For a raw `ask` spec, put the content in `state` (JSON objects are fine) and refer
  to fields in backticks inside instructions, like `` `ticket.body` ``. Questions
  run in parallel and can't see each other's answers. See
  https://docs.typesafe.ai/api.md for the full schema.

## Patterns that pay off

- **Funnel:** `qs filter` over the whole repo, then Claude reads the 5 survivors
  instead of 300 files.
- **Log triage:** `qs filter ... --lines` over a 50k-line log, then Claude
  investigates only the failures.
- **Two-pass precision:** a cheap broad `filter`, then `rank` the survivors
  against the specific question.
- **Batch triage:** dump items to JSONL (issues, test output, grep hits),
  `qs classify`, then act per bucket.

Jev handles 1,200 requests/min. Quicksilver packs small items into shared
requests, runs 8 in parallel, and retries rate limits (429/529) automatically.
