// These Unicode simple-fold groups cannot be derived by upper/lowercasing each
// member in isolation (titlecase, final sigma, sharp S, historical letters).
const irregularGroups = [
  'KkK Ssſ µΜμ ÅåÅ ßẞ ı İ Ǆǅǆ Ǉǈǉ Ǌǋǌ Ǳǲǳ ͅΙιι ΐΐ Ββϐ Εεϵ Θθϑϴ Κκϰ Ππϖ Ρρϱ Σςσ Φφϕ ΩωΩ ΰΰ',
  'Ввᲀ Ддᲁ Ооᲂ Ссᲃ Ттᲄᲅ Ъъᲆ Ѣѣᲇ ᲈꙊꙋ Ṡṡẛ',
  'ᾀᾈ ᾁᾉ ᾂᾊ ᾃᾋ ᾄᾌ ᾅᾍ ᾆᾎ ᾇᾏ ᾐᾘ ᾑᾙ ᾒᾚ ᾓᾛ ᾔᾜ ᾕᾝ ᾖᾞ ᾗᾟ',
  'ᾠᾨ ᾡᾩ ᾢᾪ ᾣᾫ ᾤᾬ ᾥᾭ ᾦᾮ ᾧᾯ ᾳᾼ ῃῌ ῳῼ ﬅﬆ',
].join(' ').split(' ');
const caseGroups = new Map<string,string>();
for (const group of irregularGroups) {
  for (const letter of group) caseGroups.set(letter, group);
}

function variants(letter: string): string {
  const irregular = caseGroups.get(letter);
  if (irregular) return irregular;
  const lower = letter.toLowerCase(), upper = letter.toUpperCase();
  return upper !== lower && [...upper].length === 1 && [...lower].length === 1 ? lower + upper : letter;
}

function asciiLower(letter: string): string {
  return letter >= 'A' && letter <= 'Z' ? letter.toLowerCase() : letter;
}

// SQLite lower() handles ASCII. Fold the additional variants relevant to this query
// in successive rows so neither SQL expression depth nor bind count grows with its length.
export function textSearch(query: string) {
  const replacements = new Map<string,string>();
  let needle = '';
  for (const letter of query) {
    const group = [...variants(letter)];
    const canonical = asciiLower(group[0]);
    needle += canonical;
    for (const variant of group) {
      const source = asciiLower(variant);
      if (source !== canonical) replacements.set(source,canonical);
    }
  }
  const prefix = `WITH RECURSIVE searchTerm(needle,phone) AS (VALUES (?,?)),
    searchFold(step,source,target) AS MATERIALIZED (
      SELECT key,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)
    ) `;
  const phone = /^[+\d\s().-]+$/.test(query) ? query.replace(/\D/g,'') : '';
  const args = [needle,phone || needle,JSON.stringify([...replacements])];
  const matches = (column:string) => {
    if (!replacements.size) return `instr(lower(${column}),(SELECT needle FROM searchTerm))>0`;
    return `(WITH RECURSIVE normalized(step,value) AS (
      SELECT 0,lower(${column}) FROM searchTerm WHERE length(${column}) >= length(needle)
      UNION ALL
      SELECT n.step+1,replace(n.value,f.source,f.target)
        FROM normalized n JOIN searchFold f ON f.step=n.step
    ) SELECT instr(value,(SELECT needle FROM searchTerm)) FROM normalized
      WHERE step=(SELECT count(*) FROM searchFold))>0`;
  };
  return {prefix,args,matches};
}
