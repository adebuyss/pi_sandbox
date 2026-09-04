---
name: page-batch
description: "Run one prompt over many images through the local vLLM server, writing resumable JSONL: bulk manga page transcription/translation, image categorisation, any 'same question, many pictures' job. Use whenever a task involves more than about ten images instead of reading them one at a time. Covers reachability from the sandbox, which serving profile you are on and how fast to expect, the repetition-loop trap, thinking defaults that differ per model, and how to triage a finished run."
---

# page-batch: one prompt over many images

Driver: `page-batch` (on PATH in the sandbox). Sends one image per request,
several in flight, and appends each result to a JSONL file as it completes.

**Use it when** a task means asking the same thing of many images (transcribe these
pages, categorise this folder, extract the text from these scans). **Do not use it**
for a handful of images — reading 3 pages with the `read` tool is faster than setting
this up, and you keep them in context where you can reason about them.

## 0. Where it lives

`page-batch` is on your PATH inside the sandbox (vendored into `~/.pi/agent/bin`
at image build from the host's canonical copy). Just run it:

```
page-batch --help
```

Only `127.0.0.1:8080` is forwarded into the sandbox, so use the default URL (the
proxy). **`:8180` is not reachable from here** — never point `--url` at it.

If `page-batch` is somehow missing (an older image), say so and hand the operator
the host command `~/ai_models/vllm/page-batch.py ...` rather than improvising a
replacement — the flags and output format below are what the rest of the pipeline
expects.

## 1. The command

```
page-batch \
  --dir <images/> --out <work>-pages.jsonl --preset translate
```

- `--preset translate` — the manga pipeline's Phase 1 prompt; emits `ja` + `en` per
  page following the conventions in the readers' `TRANSLATION-PROCEDURE.md`, so the
  output feeds its later phases with no conversion.
- `--prompt "..."` / `--prompt-file F` — anything else (categorisation, extraction).
  Emits `text` instead of `ja`/`en`.
- `--dry-run` first on a new directory: it lists what it would do and contacts nothing.
- `--limit N` to try a couple of pages before committing to hundreds.
- `--concurrency N` overrides the inference in §2.

**Always `--dry-run` once before a long run.** It shows the page-number parse and how
many are already done, which is where mistakes actually happen.

## 2. Know which profile is serving, and expect the matching speed

The script reads `max_model_len` from the server and picks concurrency from it. You
should know the same thing before promising a timeline:

| serving profile | signal | concurrency | realistic rate |
|---|---|---|---|
| agent (long context, CPU vision) | `max_model_len` ~193k | 2 | slow: the CPU vision tower is ~10 s per *unique* image |
| batch (short context, GPU vision) | `max_model_len` ~16k | 6 | ~16 pages/min |

A 273-page work is ~16 minutes on the batch profile and roughly an hour on the agent
profile. If the job is large and you are on the agent profile, say so and offer the
operator the choice rather than silently starting the slow one.

**Never switch the serving profile yourself.** It is a global change: it breaks every
other client on the endpoint, and the batch profile's 16k window cannot hold a pi
session (a clean one is already ~20k). Switching is an operator action.

## 3. Traps that have actually bitten

- **Repetition loops.** Without `presence_penalty`, pages containing lists of
  near-identical items (sound effects especially) degenerate into the same line
  repeated until `max_tokens` — 59 of 227 pages in one real run. The script now sends
  the non-thinking sampling set (including `presence_penalty 1.5`) by default, and
  records `max_repeat` per page so you can spot survivors. If you pass `--think`, you
  get the model's own sampling instead: watch `max_repeat` closely.
- **Thinking defaults differ per model.** The abliterated build's chat template
  defaults thinking **on**; stock defaults **off**. The script always sends the flag
  explicitly so behaviour does not silently change with the served model. If you use
  `--think`, raise `--max-tokens` to 8000+ — the cap covers reasoning *plus* answer.
- **Truncation.** `finish_reason: "length"` means the page hit the cap and the tail is
  missing. Raise `--max-tokens` and rerun those pages (§4).

## 4. After the run: triage, then read selectively

Each record carries `page`, `file`, `path`, `sha256`, `finish_reason`,
`prompt_tokens`, `completion_tokens`, `max_repeat`, plus `ja`/`en` (or `text`).

Triage with a command, not by reading the file into context:

```
python3 -c "
import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
print(len(rows),'pages')
print('truncated:',[r['page'] for r in rows if r.get('finish_reason')=='length'])
print('looped   :',[r['page'] for r in rows if r.get('max_repeat',1)>=5])
print('empty    :',[r['page'] for r in rows if not (r.get('en') or r.get('text'))])
" <work>-pages.jsonl
```

**Do not cat the whole JSONL.** A few hundred pages of transcription will fill your
context and destroy the very reason you batched them. Read individual records by page
number when you need them.

## 5. Resuming and retrying

The run is resumable by construction: completed pages are appended immediately, and a
rerun of the identical command **skips what is done and retries only what is missing**.
So:

- interrupted run, or a crash → just run the same command again;
- pages flagged truncated/looped in §4 → delete those lines from the JSONL, then rerun
  the same command (optionally with a higher `--max-tokens`) and only they are redone.

Report results as counts plus the output path — never by pasting page contents.
