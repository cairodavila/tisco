# tisco

ask questions about video transcripts, inspect the evidence, then move or rename the clips from your terminal.

```text
$ tisco ~/shoot
◆  what now?
│  which clips mention the price?
◇  findings · 1 match · 1 review · 1 no match · 0 not judged
│  MATCH    01-intro.MOV · match 0.93
│    Transcript opening: “today i want to explain the price...”
│  REVIEW   02-retake.MOV · match 0.50
│  NO MATCH 03-detail.MOV · match 0.07
●  find only · 1 selected match, 1 review candidate. no files changed.
◆  what now?
│  move the results into "price clips"
◇  action preview · 2 ready · 1 unclear · 0 blocked · 0 skipped
│  [x] CREATE price clips/
│  [x] MOVE 01-intro.MOV → price clips/01-intro.MOV
│  [ ] MOVE 02-retake.MOV → price clips/02-retake.MOV
◆  apply these 2 actions? · 1 review row not included
```

findings are not file operations. tisco shows what matched first, keeps uncertain clips unchecked, and asks again before changing a path.

## install

requires Node 22.13 or newer.

```sh
npm install -g @ailia/tisco
tisco --check
tisco ~/shoot
```

`ffmpeg` and `ffprobe` are needed for new transcriptions and review exports. cached transcripts can still be searched without them.

set `OPENROUTER_API_KEY`, or run `tisco --configure` for a masked prompt. tisco uses OpenRouter for both models:

- `microsoft/mai-transcribe-2` transcribes speech
- `typesafe/jev-1.13` answers typed questions about requests and transcripts

## the loop

1. tisco asks permission before scanning a directory.
2. it reports which clips have transcripts and asks before uploading missing audio.
3. you type a request in plain language.
4. findings appear as `MATCH`, `REVIEW`, `NO MATCH`, or `NOT JUDGED`.
5. if the request changes files, tisco shows every source and destination path before approval.

use follow-up requests naturally:

```text
which clips mention the warranty?
move the results into "warranty"
rename the selected clips with _final
```

`the results` includes review candidates, but they remain unchecked. `the selected clips` means the clips you explicitly selected or the confident matches from the last search.

## commands

| command | effect |
| --- | --- |
| `/results` | show every finding from the last search, locally |
| `/details` | inspect probabilities, skipped checks, and the full transcript |
| `/select` | choose findings explicitly; this changes selection, not files |
| `/undo` | restore the latest applied move or rename |
| `/export` | write review MP4s while preserving the sources |
| `/transcribe` | transcribe selected clips |
| `/context` | set project context read with later requests |
| `/key` | replace the OpenRouter key for this session |
| `/help`, `/quit` | show help or leave |

## naming

folder and suffix suggestions are copied from your request, then validated and shown for editing.

```text
put those into "approved picks"
rename the selected clips with _review
```

for full filename replacements, choose one of these in the rename prompt:

- a suffix, preserving the existing stem and extension
- numbered names such as `01-price.MOV`, sorted by source path
- the first seven transcript words, normalized into a filename

transcript-based names are source openings, not generated summaries. missing words fall back to the original stem. extensions and transcript sidecars follow the video name. collisions stay blocked until you choose another name.

## what tisco can judge

tisco judges what was said. it can find topics, names, lines, explanations, prepared takes, verbal mistakes, and repetition against a retained folder.

it does not watch the picture or listen to recording quality. a request based only on framing, focus, expressions, lighting, noise, wind, duration, prior usage, or taste is refused with the missing evidence named. if a request mixes spoken content with one of those conditions, tisco judges the spoken part and says what it left out.

probabilities at or above `0.80` are matches. values at or below `0.20` are non-matches. anything between them is a review candidate and starts unchecked.

## safety and privacy

- directory authorization is stored for that exact directory and can be revoked with `--forget-directory`
- hidden directories and symlinks are skipped
- audio upload needs confirmation; move and rename plans need a separate approval
- source files are never deleted, edited in place, or overwritten
- transcript sidecars move and rename with their videos
- collisions and changed files block the affected action
- every applied plan has a write-ahead journal in `.tisco/`
- `/undo` verifies the files before restoring their original paths
- the OpenRouter key is never printed, stored with media, or sent to a model as state

for transcription, audio is extracted locally as mono MP3 at no more than 16 kHz. a lower-rate source is not upsampled. on the 19-clip test shoot, 1.7 GB of video became 2.24 MB of uploaded audio.

Jev receives the request, project context, transcript text and timings, plus reference transcripts when the request asks for a comparison. the assembled decision state is capped at 55 KB and is never silently truncated.

## limits

- transcript evidence only; no picture or recording-quality analysis
- no timestamped cuts or coverage audit
- no PDF or DOCX briefing import; paste briefing text into `/context`
- numbered names follow source-path order, not an inferred story order
- transcript names use opening words, not semantic title generation
- Portuguese and English have been exercised most; other languages are not yet measured

## develop

```sh
pnpm install
pnpm test          # unit and integration tests, offline
pnpm test:tui      # full terminal walkthrough, offline
pnpm demo          # synthetic clips, mock transport, no key or network
pnpm eval:wording  # paid live Jev wording checks
pnpm eval:naming   # paid live naming and follow-up scope checks
```

`tisco@0.3.0` passes 85 tests, with one optional footage test skipped when its fixture is absent. the terminal walkthrough covers authorization, findings, local detail inspection, uncertainty across follow-ups, editable names, action approval, and undo.

## license

MIT
