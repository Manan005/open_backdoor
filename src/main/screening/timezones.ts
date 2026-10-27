// Country names, aliases and common cities mapped to ISO 3166 alpha-2 codes.
const PLACES: Record<string, string[]> = {
  US: ['united states of america', 'united states', 'usa', 'u.s.a.', 'u.s.', 'san francisco', 'new york', 'new york city', 'los angeles', 'seattle', 'boston', 'austin', 'chicago', 'palo alto', 'mountain view', 'san jose', 'san diego', 'denver', 'miami', 'atlanta'],
  IN: ['india', 'bengaluru', 'bangalore', 'mumbai', 'delhi', 'new delhi', 'hyderabad', 'chennai', 'pune', 'gurgaon', 'gurugram', 'noida', 'kolkata', 'ahmedabad'],
  GB: ['united kingdom', 'uk', 'u.k.', 'great britain', 'england', 'scotland', 'wales', 'london', 'manchester', 'edinburgh', 'bristol'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal', 'montréal', 'ottawa', 'calgary'],
  DE: ['germany', 'deutschland', 'berlin', 'munich', 'münchen', 'hamburg', 'cologne', 'köln', 'frankfurt'],
  FR: ['france', 'paris', 'lyon', 'marseille', 'toulouse'],
  SG: ['singapore'],
  AE: ['united arab emirates', 'uae', 'dubai', 'abu dhabi'],
  AU: ['australia', 'sydney', 'melbourne', 'brisbane', 'perth'],
  NL: ['netherlands', 'the netherlands', 'holland', 'amsterdam', 'rotterdam', 'utrecht'],
  IL: ['israel', 'tel aviv', 'tel-aviv', 'jerusalem', 'haifa'],
  BR: ['brazil', 'brasil', 'são paulo', 'sao paulo', 'rio de janeiro']
}

// Names hold only letters, spaces, '-' and '.', so '.' is the one character needing escape.
const literal = (s: string): string => s.split('.').join('[.]')

// Whole-token match, so "Indiana" is not India and "Singaporean" is not Singapore.
const MATCHERS: { code: string; re: RegExp }[] = Object.entries(PLACES).map(([code, names]) => ({
  code,
  re: new RegExp(
    '(?<![\\p{L}\\p{N}])(?:' + [...names].sort((a, b) => b.length - a.length).map(literal).join('|') + ')(?![\\p{L}\\p{N}])',
    'iu'
  )
}))

// Matches a country name or common city in free text such as "Bengaluru, Karnataka, India".
// When several countries match, the one mentioned last wins: locations end with the country.
export function countryFromText(s: string): string | null {
  if (!s) return null
  let best: { code: string; at: number } | null = null
  for (const { code, re } of MATCHERS) {
    const m = re.exec(s)
    if (m && (best === null || m.index > best.at)) best = { code, at: m.index }
  }
  return best?.code ?? null
}
