import { answerLabel } from './decisions.js';
import { transcriptText } from './naming.js';
import { safeDisplay } from './types.js';
import type { Decision, Evidence } from './types.js';

export function findingLabel(decision: Decision): string {
  return decision.error ? 'NOT JUDGED' : decision.recommendation === 'propose' ? 'MATCH' : decision.recommendation === 'review' ? 'REVIEW' : 'NO MATCH';
}

export function findingSummary(decisions: Decision[]): string {
  return ['MATCH', 'REVIEW', 'NO MATCH', 'NOT JUDGED'].map(label => `${decisions.filter(item => findingLabel(item) === label).length} ${label.toLowerCase()}`).join(' · ');
}

export function findingLines(decisions: Decision[], evidence: Evidence[]): string {
  return decisions.map(item => {
    const score = item.answers.matches_request;
    const transcript = evidence.find(row => row.clip.path === item.path)?.transcript;
    const text = transcript ? safeDisplay(transcriptText(transcript)).trim() : '';
    return `${findingLabel(item)}  ${safeDisplay(item.path)}${score ? ` · match ${answerLabel(score)}` : ''}${item.cached ? ' · cached' : ''}\n` +
      `  ${safeDisplay(item.error ?? item.reason)}\n` +
      (text ? `  Transcript opening: “${text.slice(0, 140)}${text.length > 140 ? '…' : ''}”` : '  No transcribed words. This does not prove silence.');
  }).join('\n\n');
}
