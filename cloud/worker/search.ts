// SQLite LIKE only folds ASCII. GLOB character classes can match Unicode simple
// case variants in the database, including substrings of existing records.
// These Unicode simple-fold groups cannot be derived by upper/lowercasing each
// member in isolation (titlecase, final sigma, sharp S, historical letters).
const irregularGroups = [
  'KkK Ssſ µΜμ ÅåÅ ßẞ ı İ Ǆǅǆ Ǉǈǉ Ǌǋǌ Ǳǲǳ ͅΙιι ΐΐ Ββϐ Εεϵ Θθϑϴ Κκϰ Ππϖ Ρρϱ Σςσ Φφϕ ΩωΩ ΰΰ',
  'Ввᲀ Ддᲁ Ооᲂ Ссᲃ Ттᲄᲅ Ъъᲆ Ѣѣᲇ ᲈꙊꙋ Ṡṡẛ',
  'ᾀᾈ ᾁᾉ ᾂᾊ ᾃᾋ ᾄᾌ ᾅᾍ ᾆᾎ ᾇᾏ ᾐᾘ ᾑᾙ ᾒᾚ ᾓᾛ ᾔᾜ ᾕᾝ ᾖᾞ ᾗᾟ',
  'ᾠᾨ ᾡᾩ ᾢᾪ ᾣᾫ ᾤᾬ ᾥᾭ ᾦᾮ ᾧᾯ ᾳᾼ ῃῌ ῳῼ ﬅﬆ',
].join(' ').split(' ');
const patterns = new Map<string,string>([
  ['*','[*]'], ['?','[?]'], ['[','[[]'],
  // Preserve the previous LIKE wildcard semantics.
  ['%','*'], ['_','?'],
]);
for (const group of irregularGroups) {
  for (const letter of group) patterns.set(letter, '[' + group + ']');
}

export function searchPattern(query: string): string {
  let pattern = '*';
  for (const letter of query) {
    const special = patterns.get(letter);
    if (special !== undefined) { pattern += special; continue; }
    const upper = letter.toUpperCase(), lower = letter.toLowerCase();
    // Full case expansions (e.g. ligatures) are not simple single-letter folds.
    pattern += upper !== lower && [...upper].length === 1 && [...lower].length === 1
      ? '[' + upper + lower + ']' : letter;
  }
  return pattern + '*';
}
