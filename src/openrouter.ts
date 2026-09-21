import { setTimeout as sleep } from 'node:timers/promises';
import { object, probability, text } from './types.js';
import type { Answers, Question } from './types.js';

export const STT_MODEL = 'microsoft/mai-transcribe-2';
export const JEV_MODEL = 'typesafe/jev-1.13';
const ORIGIN = 'https://openrouter.ai';
export const MAX_STATE_BYTES = 96_000;
export const MAX_DECISION_BYTES = 180_000;

export class OpenRouter {
  constructor(private key: string, private fetcher: typeof fetch = fetch) {
    if (!key.trim() || /[\r\n]/.test(key)) throw new Error('Provide a valid OpenRouter API key.');
  }

  async post(endpoint: '/api/alpha/decisions' | '/api/v1/audio/transcriptions', payload: unknown): Promise<Record<string, unknown>> {
    const data = object(payload);
    const allowed = endpoint === '/api/alpha/decisions' ? JEV_MODEL : endpoint === '/api/v1/audio/transcriptions' ? STT_MODEL : null;
    if (!allowed || data.model !== allowed) throw new Error('Only Jev decisions and MAI transcription are supported.');
    const body = JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`${ORIGIN}${endpoint}`, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'tisco' },
          body,
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        // A timeout may have been billed. Do not automatically replay an ambiguous POST.
        throw new Error('OpenRouter connection failed or timed out. Retry manually; the request may have been billed.');
      }
      if (response.ok) {
        try { return object(await response.json()); }
        catch { throw new Error('OpenRouter returned malformed JSON.'); }
      }
      const raw = await response.text();
      if (response.status === 429 && attempt < 2) {
        const header = Number(response.headers.get('retry-after'));
        await sleep(Math.min(30, Math.max(1, header || 2 ** attempt)) * 1000);
        continue;
      }
      if (raw.includes('max_tokens_exceeded') || raw.includes('context_length_exceeded')) {
        throw new Error('Jev context limit exceeded. Narrow the context/reference set; no transcript was truncated.');
      }
      const help: Record<number, string> = {
        400: 'Request rejected. Check model parameters or narrow context.',
        401: 'Invalid OpenRouter API key. Run tisco --configure.',
        402: 'OpenRouter credit limit reached.',
        403: 'OpenRouter denied access to this model.',
        429: 'OpenRouter rate limit reached; retry later.',
      };
      // Provider bodies can echo input and credentials. Never render or persist them.
      throw new Error(`OpenRouter HTTP ${response.status}: ${help[response.status] ?? 'Provider failed; retry manually.'}`);
    }
  }

  async decide(state: unknown, questions: Record<string, Question>): Promise<Answers> {
    const request = { model: JEV_MODEL, state, questions };
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES || Buffer.byteLength(JSON.stringify(request)) > MAX_DECISION_BYTES) {
      throw new Error(`Context exceeds tisco's Jev guard. Split the workspace state; nothing was truncated.`);
    }
    const result = await this.post('/api/alpha/decisions', request);
    const raw = object(result.answers);
    const answers: Answers = {};
    for (const [id, question] of Object.entries(questions)) {
      const answer = object(raw[id]);
      if (answer.type !== question.type) throw new Error(`Missing or wrong answer type for ${id}.`);
      if (question.type === 'noul') {
        answers[id] = { type: 'noul', noul: probability(answer.noul) };
      } else {
        const choice = text(answer.choice, 'choice');
        if (!Object.hasOwn(question.criteria, choice)) throw new Error(`Unknown choice for ${id}.`);
        const distribution = object(answer.probabilities);
        const probabilities = Object.fromEntries(Object.keys(question.criteria).map(option => [option, probability(distribution[option])]));
        const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
        // OpenRouter rounds probabilities to two decimals.
        if (Math.abs(sum - 1) > Math.max(0.03, Object.keys(probabilities).length * 0.011)) throw new Error(`Invalid choice distribution for ${id}.`);
        answers[id] = { type: 'choice', choice, probabilities, confidence: probability(answer.confidence) };
      }
    }
    return answers;
  }

  transcribe(audio: Buffer, language?: string): Promise<Record<string, unknown>> {
    return this.post('/api/v1/audio/transcriptions', {
      model: STT_MODEL,
      input_audio: { data: audio.toString('base64'), format: 'mp3' },
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      ...(language ? { language } : {}),
    });
  }
}
