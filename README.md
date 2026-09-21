<div align="center">

# tisco

**find the words. review the clips. approve the changes.**

ask questions about video transcripts, then organize the matching clips from your terminal.

[![Node.js ≥22.13](https://img.shields.io/badge/Node.js-%E2%89%A522.13-417E38?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![OpenRouter](https://img.shields.io/badge/models-OpenRouter-6366F1?style=flat-square)](https://openrouter.ai/)
[![MIT license](https://img.shields.io/badge/license-MIT-64748B?style=flat-square)](LICENSE)

[quick start](#quick-start) · [how it works](#how-it-works) · [commands](#commands) · [privacy](#privacy) · [development](#development)

</div>

---

## from a question to a folder

```text
which clips mention the warranty?
move the results into "warranty"
rename the selected clips with _final
```

tisco searches what was said, shows the findings, and previews each path change. you can inspect the transcripts, change the names, or cancel before anything moves.

| find | inspect | organize |
| :--- | :--- | :--- |
| topics, names, lines, prepared takes, and verbal mistakes | match probabilities and full transcripts | move clips, rename files, and export review MP4s |

> tisco reads transcripts, not pictures. it cannot judge focus, lighting, expressions, or recording quality.

## quick start

requires **Node.js 22.13+** and an **OpenRouter API key**. install `ffmpeg` and `ffprobe` for new transcriptions and review exports.

```sh
npm install -g @ailia/tisco

tisco --configure   # enter your OpenRouter key in a masked prompt
tisco --check       # check local media tools
tisco ~/shoot       # open a shoot folder
```

you can also provide the key through `OPENROUTER_API_KEY`. cached transcripts can be searched without ffmpeg.

on first use, tisco asks permission to scan the folder, then offers to transcribe clips that have no transcript. **audio uploads and new model requests are billed through OpenRouter.** declining transcription uploads nothing.

<details>
<summary>run from source</summary>

```sh
git clone https://github.com/cairodavila/tisco.git
cd tisco
pnpm install
pnpm build
node dist/cli.js ~/shoot
```

</details>

## how it works

### 1. ask about the clips

type a request in plain language. tisco resolves which clips to search before judging their transcripts. name an existing source folder when you want to limit the search:

```text
from the "relevant videos" folder, which clips contain incomplete sentences?
```

Jev chooses among the folders tisco actually found; it does not invent a path. folders mentioned only as destinations are kept separate. an empty or stale selection never silently becomes the whole shoot.

Jev judges against the whole workspace, not one clip in isolation: the directory structure, folder membership, transcripts, earlier findings, and your selections travel in one shared state, and a clip's questions are answered in a single batch against it.

### 2. read the findings

| finding | meaning | selected by default? |
| :--- | :--- | :---: |
| `MATCH` | probability at or above `0.80` | yes |
| `REVIEW` | probability between `0.20` and `0.80` | no |
| `NO MATCH` | probability at or below `0.20` | no |
| `NOT JUDGED` | the check was skipped or could not be completed | no |

use `/details` to inspect the probabilities, skipped checks, and full transcript. transcript openings are previews of the source words, not model-selected citations.

### 3. approve the exact changes

an action preview shows every source and destination path:

```text
[x] CREATE warranty/
[x] MOVE 01-intro.MOV → warranty/01-intro.MOV
[ ] MOVE 02-retake.MOV → warranty/02-retake.MOV
```

review candidates stay unchecked. edit the proposed names, choose individual rows, or cancel. only approval applies the plan; `/undo` can restore the original paths afterward.

**follow-up scope matters:** “the results” includes review candidates without selecting them. “the selected clips” uses your explicit selection or the confident matches from the last search. `/select` changes that selection, not the files.

## naming

folder and suffix suggestions come from literal words in your request. quote multiword folder names:

```text
put those into "approved picks"
rename the selected clips with _review
```

| option | result |
| :--- | :--- |
| **append a suffix** | preserve the original name and add `_review` before the extension |
| **numbered label** | names such as `01-price.MOV`, ordered by source path |
| **transcript opening** | a number plus the first seven transcript words, normalized for filenames |

all proposed names are editable before approval. transcript openings are not generated summaries; missing words fall back to the original stem. extensions and transcript sidecars follow the video name. collisions are blocked, never automatically overwritten.

## commands

| command | what it does |
| :--- | :--- |
| `/results` | show every finding from the last search, locally |
| `/details` | inspect probabilities, skipped checks, and the full transcript |
| `/select` | choose findings without authorizing file changes |
| `/undo` | restore the latest applied move or rename plan |
| `/export` | write review MP4s while preserving the sources |
| `/transcribe` | transcribe selected clips |
| `/context` | set project context for later requests |
| `/key` | replace the OpenRouter key for this session |
| `/help` | show available commands |
| `/quit` | leave the workspace |

## privacy

| stays local | sent through OpenRouter |
| :--- | :--- |
| original videos, file operations, and undo journals | extracted audio when you approve transcription |
| directory permissions and cached evidence | your request, project context, transcript text and timings, and reference transcripts for comparisons |

transcription uses **mono MP3 at no more than 16 kHz**, extracted locally. lower-rate audio is not upsampled. in one 19-clip test, 1.7 GB of video became 2.24 MB of uploaded audio.

only two models are used:

- **`microsoft/mai-transcribe-2`** transcribes speech.
- **`typesafe/jev-1.13`** returns typed judgments about requests and transcripts. code controls permissions, thresholds, paths, and file operations.

the workspace state sent to Jev is capped at 96 KB and never silently truncated. when a workspace exceeds it, the state is split deterministically into batches and merged back into the same per-clip decisions. the OpenRouter key is never printed, stored with media, or included in model state.

### file safety

- directory permission applies to that exact directory; revoke it with `--forget-directory`.
- hidden directories and symlinks are skipped.
- uploads and file changes have separate approval steps.
- source files are never deleted, edited in place, or overwritten.
- sidecars move and rename with their videos.
- collisions and changed files block the affected action.
- every applied plan has a write-ahead journal in `.tisco/`; undo verifies files before restoring paths.

## limits

spoken-content searches can cover topics, names, lines, explanations, prepared takes, verbal mistakes, and repetition against a retained folder.

requests that depend only on picture, recording quality, duration, prior usage, or taste are refused with the missing evidence named. for mixed requests, tisco judges the spoken part and says what it left out.

also not supported:

- timestamped cuts or coverage audits
- PDF or DOCX briefing import; paste text into `/context` instead
- inferred story order; numbered names follow source-path order
- generated semantic titles; transcript names use opening words

Portuguese and English have been exercised most. other languages are not yet measured.

## development

```sh
pnpm install
pnpm test          # unit and integration tests, offline
pnpm test:tui      # terminal walkthrough, offline
pnpm demo          # synthetic clips; no key or network
```

<details>
<summary>live model checks and test coverage</summary>

these checks make paid OpenRouter requests:

```sh
pnpm eval:wording  # Jev wording checks
pnpm eval:naming   # naming and follow-up scope checks
```

the `0.4.0` verification run had **92 passing tests and one optional footage test skipped**. the terminal walkthrough covers authorization, findings, local detail inspection, uncertainty across follow-ups, editable names, action approval, and undo.

</details>

## license

[MIT](LICENSE)
