/**
 * A deliberately small abuse filter for player chat.
 *
 * The term categories were cross-checked against the Chinese and English
 * lists in LDNOOBW (Shutterstock, CC BY 4.0), but this is a hand-curated
 * subset for game chat. We do not import a broad sensitive-word or political
 * list, because ordinary game discussion must remain possible.
 *
 * Source: https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words
 * License: https://creativecommons.org/licenses/by/4.0/
 */

interface INormalizedCharacter {
  character: string;
  start: number;
  end: number;
}

interface IMatch {
  start: number;
  end: number;
}

/**
 * Keep terms specific enough to avoid masking ordinary words (for example,
 * `ass` would incorrectly mask `class`). Chinese variants are listed where
 * there is no safe character-by-character conversion for both scripts.
 */
const PROFANITY_TERMS = [
  // English abuse and profanity.
  'motherfucker',
  'bullshit',
  'asshole',
  'dumbass',
  'bastard',
  'bitch',
  'cunt',
  'dickhead',
  'fuck',
  'shit',
  'dick',
  'pussy',
  'whore',
  'slut',
  'retard',
  // Common Chinese abuse and profanity, simplified and traditional.
  '操你妈',
  '操你媽',
  '肏你妈',
  '肏你媽',
  '艹你妈',
  '艹你媽',
  '草泥马',
  '草泥馬',
  '他妈的',
  '他媽的',
  '妈的',
  '媽的',
  '傻逼',
  '傻屄',
  '傻比',
  '屌你',
  '屌你媽',
  '屌你妈',
  '鸡巴',
  '雞巴',
  '屁眼',
  '狗日',
  '去死',
  // Targeted phrases retain context while leaving ordinary game terms alone.
  '你这个垃圾',
  '你是废物',
  // Widely understood abbreviated insults, including Chinese internet usage.
  'nmsl',
  'cnm',
] as const;

/**
 * Characters whose simplified/traditional forms are common in profanity.
 * This is intentionally limited to terms in the curated list rather than a
 * general-purpose language conversion table.
 */
const TRADITIONAL_TO_SIMPLIFIED: Readonly<Record<string, string>> = {
  媽: '妈',
  馬: '马',
  雞: '鸡',
  這: '这',
  廢: '废',
  屄: '逼',
  屌: '屌',
  肏: '操',
};

const ZERO_WIDTH_OR_FORMATTING =
  /(?:\u00ad|\u034f|\u061c|\u115f|\u1160|\u17b4|\u17b5|[\u180b-\u180f]|[\u200b-\u200f]|[\u202a-\u202e]|[\u2060-\u2064]|[\u2066-\u206f]|\u3164|\ufeff)/u;

function normalizeTerm(term: string): string {
  return [...term.normalize('NFKC').toLocaleLowerCase('en-US')]
    .map((character) => TRADITIONAL_TO_SIMPLIFIED[character] ?? character)
    .filter((character) => !ZERO_WIDTH_OR_FORMATTING.test(character))
    .filter((character) => /[a-z0-9\u3400-\u9fff]/u.test(character))
    .join('');
}

function normalizedCharacters(body: string): INormalizedCharacter[] {
  const characters: INormalizedCharacter[] = [];
  let offset = 0;

  for (const sourceCharacter of body) {
    const start = offset;
    offset += sourceCharacter.length;
    const normalized = sourceCharacter
      .normalize('NFKC')
      .toLocaleLowerCase('en-US');

    for (const character of normalized) {
      if (ZERO_WIDTH_OR_FORMATTING.test(character)) continue;
      const simplified = TRADITIONAL_TO_SIMPLIFIED[character] ?? character;
      // Punctuation, spaces, combining marks, and emoji are separators for
      // matching purposes. Their source span remains covered when a match
      // crosses them, so `f.u.c.k` and `傻-逼` are masked in full.
      if (!/[a-z0-9\u3400-\u9fff]/u.test(simplified)) continue;
      characters.push({ character: simplified, start, end: offset });
    }
  }

  return characters;
}

function findMatches(body: string): IMatch[] {
  const characters = normalizedCharacters(body);
  const normalizedBody = characters.map(({ character }) => character).join('');
  const terms = PROFANITY_TERMS.map(normalizeTerm)
    .filter((term) => term.length > 0)
    .sort((left, right) => right.length - left.length);
  const matches: IMatch[] = [];

  for (const term of terms) {
    let fromIndex = 0;
    while (fromIndex < normalizedBody.length) {
      const matchIndex = normalizedBody.indexOf(term, fromIndex);
      if (matchIndex < 0) break;
      const endIndex = matchIndex + term.length - 1;
      const start = characters[matchIndex]?.start;
      const end = characters[endIndex]?.end;
      if (start !== undefined && end !== undefined) {
        matches.push({ start, end });
      }
      fromIndex = matchIndex + Math.max(term.length, 1);
    }
  }

  return matches;
}

/**
 * Mask matched text while preserving unrelated text exactly. The returned
 * value is the only body passed to persistence, so history and live delivery
 * observe the same filtered representation.
 */
export function filterChatBody(body: string): string {
  const matches = findMatches(body);
  if (matches.length === 0) return body;

  const mask = new Set<number>();
  for (const match of matches) {
    for (let index = match.start; index < match.end; index += 1) {
      mask.add(index);
    }
  }

  let filtered = '';
  let offset = 0;
  for (const character of body) {
    const end = offset + character.length;
    filtered +=
      mask.has(offset) || mask.has(end - 1)
        ? '*'.repeat(character.length)
        : character;
    offset = end;
  }
  return filtered;
}
