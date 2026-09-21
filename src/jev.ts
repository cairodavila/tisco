import type { Question } from './types.js';

/**
 * Everything provider-facing lives here: the exact wording Jev reads, and the state it
 * reads it against. The gate table in decisions.ts owns ids, tiers and dependencies, and
 * asks for a question by id. Changing how a question is phrased must never touch that
 * table, and changing a gate must never touch this file.
 *
 * The wording is measured, not chosen by taste; `tools/wording-eval.mjs` scores it
 * against labelled requests through the real model. Three rules came out of that:
 *
 * 1. Frame the question as what the user wants, not as a property of a text. Metaphors
 *    about operations being "carried out" read as near-ties, and a near-tie is a no.
 * 2. Put the concrete phrasings a user would type into `criteria`. TypeSafe's own
 *    guidance is that the explanation you find yourself giving after a wrong answer is
 *    the missing half of the instruction; measured, examples moved move/create from 2/7
 *    and 3/7 to 6/7, and they carry across languages.
 * 3. Keep the negative branch a plain scan ("the text says nothing about …"). It is what
 *    keeps unrelated requests from firing an operation they never asked for.
 */

/** Sent with every decision so the model never invents a capability the release lacks. */
export const CAPABILITIES = 'Transcript classification and reversible whole-file folder organization: find matching clips, create a directory, move files with their sidecars, and rename files with explicitly confirmed names. No deletion, shell generation, video editing, or general chat.';

const WHAT_THE_USER_WANTS = 'The user typed the text in `instruction`. Answer with what the user wants done with their videos.';
const noul = (instructions: string, yes: string, no: string): Question => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

/** Tier 0: what the request asks for. */
export function routeQuestion(id: string, folders: string[]): Question {
  switch (id) {
    case 'ops_find': return noul(WHAT_THE_USER_WANTS,
      'The user wants particular clips picked out, selected, or separated from the rest by any condition, for example "the takes where I explain the recipe", "the clips with clean speech", "separe os takes bons das falas", "the ones without mistakes", "the clips where he is smiling", "the clips longer than 20 seconds", or "the clips nobody has used before". The condition may concern words, picture, sound, file metadata, or outside history.',
      'The text names no condition for choosing among the clips.');
    case 'ops_create': return noul(WHAT_THE_USER_WANTS,
      'The user wants a folder to hold the clips, for example "put them in selects", "create a folder called drafts", or "jogue o resto em broll".',
      'The text says nothing about a folder or a place for the clips.');
    case 'ops_move': return noul(WHAT_THE_USER_WANTS,
      'The user wants the clip files put into a folder, for example "put them in selects", "move to broll", or "jogue o resto em broll".',
      'The text says nothing about moving or putting the clips anywhere.');
    case 'ops_rename': return noul(WHAT_THE_USER_WANTS,
      'The user wants different file names, for example "rename them with _final" or "add the date to the name".',
      'The text says nothing about renaming.');
    case 'ops_extract': return noul(WHAT_THE_USER_WANTS,
      'The user wants part of a clip cut out, for example "cut from 0:30 to 0:45".',
      'The text says nothing about cutting part of a clip.');
    case 'criterion_requested': return noul(WHAT_THE_USER_WANTS,
      'The user describes what the clips should contain, show, or sound like: a topic, a spoken line, good or prepared takes versus rehearsal chatter ("takes bons das falas"), a kind of moment, a visible expression, good lighting, clean audio, or material to leave out.',
      'The text names no criterion about the contents, picture, or sound. A file measurement such as duration, or outside history such as whether a clip was used before, is not content.');
    // These questions are speculative fan-out: each reads the instruction directly and
    // code ignores them when no filtering operation was requested. They do not depend on
    // a sibling answer, so a second request would add latency without adding evidence.
    case 'spoken_content_decides': return noul(WHAT_THE_USER_WANTS,
      'At least one thing the user asks for lives in the words: a topic, a spoken line, a name or a price, a kind of moment, a prepared take, or a mistake in how something was said. The user may also ask for something else, such as how the clip looks or sounds.',
      'Nothing the user asks for lives in the words, and no reading of the words could decide it. Every part of it is about how the footage was filmed, how the recording sounds, a file measurement, or history and taste: for example "the clips where he is smiling", "the well-lit ones", "the clips with clean audio", "os clipes com áudio limpo e sem vento", "the clips longer than 20 seconds", or "the clips nobody has used yet".');
    // Several limitations can coexist, so each is a Noul. A Choice would force picture
    // and sound to compete even when the request asks for both.
    case 'needs_picture': return noul('Does any part of `instruction` require watching the picture to decide?',
      'Yes. It asks about framing, focus, lighting, expressions, what is visible, or camera movement.',
      'No part of the request asks how the footage looks.');
    case 'needs_sound': return noul('Does any part of `instruction` require listening to recording quality rather than reading the words?',
      'Yes. It asks about clean audio, wind, background noise, echo, music, loudness, or another property of the recording. This is about how it sounds, not what was said.',
      'No part asks about recording quality. A stumble in a line or whether an explanation is clear is decided from the words, not the sound.');
    case 'needs_measurement': return noul('Does any part of `instruction` require an exact file or clip measurement that a transcript does not contain?',
      'Yes. It asks about duration, resolution, recording time, file size, or another value code must measure.',
      'No part asks for a file or clip measurement.');
    case 'needs_external_record': return noul('Does any part of `instruction` require history, personal taste, or another record outside the transcript and file metadata?',
      'Yes. It asks which clip someone used before, which take a person will like best, or another fact that needs an outside record or human preference.',
      'No part depends on outside history or personal taste.');
    case 'target_set': return {
      type: 'choice',
      instructions: 'Which existing set supplies the input clips? Choose a listed folder when the user says to search, find, or work from that folder. Do not choose a folder mentioned only as a destination after words such as into or to. Choose all_here when the user describes a condition applied to the current folder, says all or every clip, or names no particular set. References such as "them" within the same find-and-move instruction refer to the clips identified in that instruction, not earlier results. Choose previous_result or current_selection only when referring back to an earlier result or an existing selection. Choose missing only when the text cannot be understood at all.',
      criteria: {
        all_here: 'Every eligible clip in the current folder, or every clip matching the condition the user described.',
        root_only: 'Only clips at the top level, leaving subfolders alone.',
        include_subfolders: 'Clips in the current folder and in all of its subfolders.',
        current_selection: 'Only the explicitly selected clips: "the selection", "selected clips", "os selecionados".',
        previous_result: 'The clips produced by the previous request: "the results", "those", "them", "esses", "os resultados". This set can still include uncertain candidates.',
        ...Object.fromEntries(folders.map((folder, index) => [`folder_${index}`, `Only clips already inside the existing folder ${JSON.stringify(folder)}, including its subfolders. This folder is the source scope, not a destination.`])),
        missing: 'The text cannot be understood well enough to say.',
      },
    };
    case 'reference_set': return {
      type: 'choice',
      instructions: 'Does `instruction` compare the clips against clips already kept in one of the listed existing folders? Choose none unless the user clearly points at one of them.',
      criteria: {
        none: 'The user does not compare against an existing folder.',
        ...Object.fromEntries(folders.map((folder, index) => [`folder_${index}`, `The user compares against the clips already in ${JSON.stringify(folder)}.`])),
      },
    };
    default: throw new Error(`No Jev wording for route question ${id}.`);
  }
}

/** Speculative source-value selection: none is valid, and code confirms every suggestion. */
export function namingQuestions(candidates: string[]): Record<string, Question> {
  if (!candidates.length) return {};
  const options = Object.fromEntries(candidates.map((name, index) => [`name_${index}`, JSON.stringify(name)]));
  return {
    destination_name: {
      type: 'choice',
      instructions: 'Which candidate is the exact destination folder name explicitly requested in `instruction`? Select none if not stated or if no candidate matches exactly. Do not select a reference folder, topic, or rename suffix.',
      criteria: { none: 'No exact destination folder name is available.', ...options },
    },
    rename_suffix: {
      type: 'choice',
      instructions: 'Which candidate is the exact suffix the user explicitly asks to append to existing video filenames in `instruction`? Choose none for replacement names, generated titles, numbering, or no suffix request.',
      criteria: { none: 'No explicit append suffix is available.', ...options },
    },
  };
}

function clipQuestionFor(id: string, target: string, reference: string, extra?: string): Question {
  const video = `\`${target}\``;
  switch (id) {
    case 'matches_request': return noul(`Does the speech in ${video} match every part of \`instruction\` that reading the words can decide? When \`unjudgeable\` is present, ignore those named parts completely.`,
      'The speech fits the decidable request: for example it covers the named topic, says the named line, contains the requested complete statement, or has the requested property of the words.',
      'The speech does not fit the decidable request, even if the clip contains other speech.');
    case 'has_scripted_segment': return noul(`Does ${video} contain a complete take that was prepared for an audience?`,
      'At least one take is something said to the camera for the audience to watch, for example a hook, an explanation, an invitation, an outro, or a single statement delivered to camera. It only has to be a complete thought; it does not have to be long. Retakes, mistakes and on-set talk elsewhere in the clip do not disqualify it.',
      'No complete prepared take: only incidental conversation, production directions, a fragment that starts or stops mid-sentence, or no intelligible speech.');
    case 'has_incomplete_speech': return noul(`Does ${video} contain a meaningful sentence or take that starts late, ends early, trails off unfinished, or is interrupted before the thought is complete?`,
      'At least one meaningful spoken thought is incomplete or cut off. Production cues and a complete short sentence do not count.',
      'Every meaningful spoken thought is complete, or there is no meaningful transcribed speech.');
    case 'speech_kind': return {
      type: 'choice',
      instructions: `Which kind of speech does ${video} contain? Retakes alone are not mumbling, and a short intelligible command is on-set speech rather than silence.`,
      criteria: {
        actual_speech: 'Substantive narration or conversation the audience is meant to hear.',
        on_set: 'Production directions, casual reactions or trivial cues, with no substantive narration.',
        unclear: 'Mostly broken or unintelligible fragments; no meaningful dialogue can be established.',
        no_transcribed_speech: 'Nothing was transcribed at all. This does not prove the recording is silent.',
      },
    };
    case 'speech_already_in_reference': return noul(`Does ${video} repeat a message already kept in ${reference}?`,
      'A meaningful line in this clip is already covered by the reference folder, including a repeated take of the same line.',
      'No meaningful line is covered, or this clip has no intelligible speech to cover.');
    case 'other_speech_not_in_reference': return noul(`Does ${video} say anything meaningful that ${reference} does not?`,
      'This clip says something worth keeping that the reference folder does not say.',
      'Everything meaningful in this clip is already in the reference folder, or it says nothing meaningful.');
    case 'cleanest_take': return noul(`Does ${video} contain one clean, complete take that should be kept?`,
      'One take in this clip is clearly the complete, clean keeper.',
      'No single take stands out as complete and clean.');
    case 'duplicate_of': return noul(`Would anything useful be lost by keeping only ${reference}?`,
      `Something useful would be lost, because ${video} says more.`,
      `Nothing useful would be lost: ${video} only repeats the reference material.`);
    default: return noul(`Look only at ${video}. ${extra ?? ''}`.trim(),
      'The stated condition holds for this clip.',
      'The stated condition does not hold for this clip.');
  }
}

/** Tier 1 (per clip) and tier 2 (only reachable once tier 1 admits it). */
export function clipQuestion(id: string, extra?: string): Question {
  return clipQuestionFor(id, 'current_video', '`reference_videos`', extra);
}

export function workspaceClipQuestion(id: string, videoIndex: number, extra?: string): Question {
  return clipQuestionFor(id, `workspace.videos[${videoIndex}]`, 'the videos listed by `reference_folder` in `workspace.folders`', extra);
}

export function folderRelationQuestions(folders: string[]): Record<string, Question> {
  if (folders.length > 254) throw new Error('Jev Choice supports at most 254 candidate folders plus none. Narrow the workspace.');
  const choices = Object.fromEntries(folders.map((folder, index) => [`folder_${index}`, `The selected videos belong with the existing folder ${JSON.stringify(folder)} based on the spoken content already stored there.`]));
  return {
    destination_folder: {
      type: 'choice',
      instructions: 'Which existing folder best fits the combined spoken content of `selected_videos`? Compare their transcripts with the transcripts of each folder’s `all_videos`. Choose none when no folder is a clear semantic or editorial fit. Folder names alone are weak evidence.',
      criteria: { none: 'No existing folder is a clear fit.', ...choices },
    },
    ...Object.fromEntries(folders.map((folder, index) => [`folder_${index}_related`, noul(
      `Is the combined spoken content of \`selected_videos\` genuinely related to the material already in the existing folder ${JSON.stringify(folder)}? Read that folder’s \`all_videos\` in \`workspace.folders\` and their transcripts in \`workspace.videos\`.`,
      'The selected videos cover the same topic, purpose, scene, or editorial category as the folder’s existing material.',
      'The relationship is weak, based only on a generic folder name, or the folder has no relevant transcript evidence.',
    )])),
  };
}

