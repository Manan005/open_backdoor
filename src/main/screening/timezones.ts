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

const COUNTRY_ZONES: Record<string, string> = {
  US: 'America/New_York', IN: 'Asia/Kolkata', GB: 'Europe/London', CA: 'America/Toronto', DE: 'Europe/Berlin',
  FR: 'Europe/Paris', SG: 'Asia/Singapore', AE: 'Asia/Dubai', AU: 'Australia/Sydney', NL: 'Europe/Amsterdam',
  IL: 'Asia/Jerusalem', BR: 'America/Sao_Paulo'
}

// Cities whose zone differs from their country's default, plus the common hubs.
const CITY_ZONES: Record<string, string> = {
  'san francisco': 'America/Los_Angeles', 'los angeles': 'America/Los_Angeles', seattle: 'America/Los_Angeles',
  'palo alto': 'America/Los_Angeles', 'mountain view': 'America/Los_Angeles', 'san jose': 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles', vancouver: 'America/Vancouver', denver: 'America/Denver',
  calgary: 'America/Edmonton', austin: 'America/Chicago', chicago: 'America/Chicago',
  'new york': 'America/New_York', 'new york city': 'America/New_York', boston: 'America/New_York',
  miami: 'America/New_York', atlanta: 'America/New_York', toronto: 'America/Toronto', montreal: 'America/Toronto',
  montréal: 'America/Toronto', ottawa: 'America/Toronto',
  bengaluru: 'Asia/Kolkata', bangalore: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata',
  'new delhi': 'Asia/Kolkata', hyderabad: 'Asia/Kolkata', chennai: 'Asia/Kolkata', pune: 'Asia/Kolkata',
  gurgaon: 'Asia/Kolkata', gurugram: 'Asia/Kolkata', noida: 'Asia/Kolkata', kolkata: 'Asia/Kolkata',
  ahmedabad: 'Asia/Kolkata', london: 'Europe/London', berlin: 'Europe/Berlin', paris: 'Europe/Paris',
  amsterdam: 'Europe/Amsterdam', singapore: 'Asia/Singapore', dubai: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai',
  sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', brisbane: 'Australia/Brisbane',
  perth: 'Australia/Perth', 'tel aviv': 'Asia/Jerusalem', 'tel-aviv': 'Asia/Jerusalem',
  'são paulo': 'America/Sao_Paulo', 'sao paulo': 'America/Sao_Paulo'
}

// IANA zone for a startup's location: a known city wins, else the country's default, else null.
export function timezoneFor(country: string | null, city: string | null): string | null {
  if (city) {
    const whole = city.trim().toLowerCase()
    const first = whole.split(',')[0].trim()
    const zone = CITY_ZONES[whole] ?? CITY_ZONES[first]
    if (zone) return zone
  }
  return country ? (COUNTRY_ZONES[country.toUpperCase()] ?? null) : null
}
