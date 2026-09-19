import { randomInt } from 'node:crypto';

// Ambiguous characters (0/O, 1/I/L) are omitted so a one-time password can be
// read aloud or copied from a screen without mistakes.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Returns a human-friendly one-time password, e.g. `K7QF-M2XR-9TDA`.
 * 12 characters of ~5 bits each (~59 bits of entropy) drawn from a rejection-
 * free CSPRNG source (`crypto.randomInt`), grouped for legibility.
 */
export function generateOneTimePassword(): string {
  const groups: string[] = [];
  for (let group = 0; group < 3; group += 1) {
    let chunk = '';
    for (let i = 0; i < 4; i += 1) {
      chunk += ALPHABET[randomInt(ALPHABET.length)];
    }
    groups.push(chunk);
  }
  return groups.join('-');
}
