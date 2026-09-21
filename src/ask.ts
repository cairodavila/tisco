import * as ui from '@clack/prompts';
import { safeDisplay } from './types.js';

/** User pressed Escape / Ctrl+C at a prompt. Never an error. */
export class Cancelled extends Error {}

export async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
  const result = await prompt;
  if (typeof result === 'symbol') throw new Cancelled();
  return result as Exclude<T, symbol>;
}

export const confirm = (message: string, initialValue = false) => ask(ui.confirm({ message, initialValue }));
export const errorMessage = (error: unknown) => safeDisplay(error instanceof Error ? error.message : 'Unexpected error.');
export const input = (message: string, initialValue = '') => ask(ui.text({
  message, initialValue,
  validate: (value: unknown) => {
    const text = typeof value === 'string' ? value : '';
    if (!text.trim()) return 'Enter a value.';
    return text.length > 4000 ? 'Use 4,000 characters or fewer.' : undefined;
  },
})).then(value => value.trim());
