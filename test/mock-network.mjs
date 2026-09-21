import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url, init) => {
  if (url !== 'https://openrouter.ai/api/alpha/decisions') throw new Error('Demo blocks all network requests.');
  const request = JSON.parse(init.body);
  if (process.env.TISCO_DEMO_REQUEST_LOG) appendFileSync(process.env.TISCO_DEMO_REQUEST_LOG, JSON.stringify(request) + '\n');
  const text = String(request.state?.instruction ?? '').toLowerCase();
  const wantsMove = /move|put|into|separate/.test(text);
  const wantsCreate = /create|folder|drafts/.test(text);
  const wantsRename = /rename|suffix|append/.test(text);
  const wantsFind = /find|which|separate|prepared|match/.test(text);
  // Feasibility fixtures: one request that asks only for a look, one that mixes a sound
  // request into a spoken one, and the ordinary requests that must stay untouched.
  const needsPicture = /smiling|well-lit|looks happy/.test(text);
  const needsSound = /clean audio|wind|noise/.test(text);
  const needsMeasurement = /longer than|seconds|resolution|file size/.test(text);
  const needsExternal = /used before|like best/.test(text);
  const hasSpokenCriterion = /price|prepared|match|explain|mention/.test(text);
  const video = request.state?.current_video?.video ?? '';
  const scripted = video.includes('01-intro');
  const unclear = video.includes('02-setup');
  const quiet = video.includes('03-detail');
  const nouls = {
    ops_find: wantsFind ? 0.93 : 0.07,
    ops_create: wantsMove || wantsCreate ? 0.9 : 0.05,
    ops_move: wantsMove ? 0.94 : 0.05,
    ops_rename: wantsRename ? 0.9 : 0.05,
    ops_extract: 0.05,
    criterion_requested: wantsFind ? 0.9 : 0.1,
    spoken_content_decides: (needsPicture || needsSound || needsMeasurement || needsExternal) && !hasSpokenCriterion ? 0.05 : 0.93,
    needs_picture: needsPicture ? 0.95 : 0.05,
    needs_sound: needsSound ? 0.95 : 0.05,
    needs_measurement: needsMeasurement ? 0.95 : 0.05,
    needs_external_record: needsExternal ? 0.95 : 0.05,
    // 02-setup sits between the thresholds on purpose: the fixture must exercise the
    // unclear band, where a row is offered but a blanket Enter must not take it.
    matches_request: text.includes('nothing matches') ? 0.03 : text.includes('broader match') ? 0.95 : scripted ? 0.93 : unclear ? 0.50 : 0.07,
    has_scripted_segment: scripted ? 0.95 : unclear ? 0.45 : 0.05,
    has_incomplete_speech: unclear ? 0.9 : 0.05,
    speech_already_in_reference: 0.05,
    other_speech_not_in_reference: quiet ? 0.03 : 0.93,
  };
  const answers = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const baseId = id.includes('__') ? id.slice(id.indexOf('__') + 2) : id;
    const videoIndex = Number(question.instructions.match(/workspace\.videos\[(\d+)\]/)?.[1]);
    const judgedVideo = Number.isInteger(videoIndex) ? request.state?.workspace?.videos?.[videoIndex]?.path ?? '' : video;
    const judgedScripted = judgedVideo.includes('01-intro');
    const judgedUnclear = judgedVideo.includes('02-setup');
    const judgedQuiet = judgedVideo.includes('03-detail');
    const clipNouls = {
      matches_request: text.includes('nothing matches') ? 0.03 : text.includes('broader match') ? 0.95 : judgedScripted ? 0.93 : judgedUnclear ? 0.50 : 0.07,
      has_scripted_segment: judgedScripted ? 0.95 : judgedUnclear ? 0.45 : 0.05,
      has_incomplete_speech: judgedUnclear ? 0.9 : 0.05,
      speech_already_in_reference: 0.05,
      other_speech_not_in_reference: judgedQuiet ? 0.03 : 0.93,
    };
    if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: baseId.startsWith('folder_') && baseId.endsWith('_related') ? 0.05 : clipNouls[baseId] ?? nouls[baseId] ?? 0.91 };
      continue;
    }
    const options = Object.keys(question.criteria);
    const folder = text.match(/(?:into|in|called|to)\s+(?:"([^"]+)"|(\S+))/);
    const suffix = text.match(/with\s+(_\w+)/)?.[1];
    const nameChoice = value => options.find(option => question.criteria[option] === JSON.stringify(value)) ?? 'none';
    const literalFolder = nameChoice(folder?.[1] ?? folder?.[2]);
    const choice = id === 'destination_name' ? (literalFolder !== 'none' ? literalFolder : options.filter(option => option.startsWith('name_')).at(-1) ?? 'none')
      : id === 'rename_suffix' ? nameChoice(suffix)
      : id === 'target_set' ? (/results|those/.test(text) ? 'previous_result' : /selected/.test(text) ? 'current_selection' : /subfolders/.test(text) ? 'include_subfolders' : 'all_here')
      : id === 'reference_set' || id === 'destination_folder' ? 'none'
      : baseId === 'speech_kind' ? (judgedScripted ? 'actual_speech' : judgedQuiet ? 'no_transcribed_speech' : 'on_set')
      : options[0];
    if (!options.includes(choice)) throw new Error(`Unexpected demo question: ${id}`);
    const rest = options.filter(option => option !== choice);
    answers[id] = {
      type: 'choice', choice, confidence: 0.94,
      probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 0.94 : 0.06 / Math.max(1, rest.length)])),
    };
  }
  return Response.json({ answers });
};
