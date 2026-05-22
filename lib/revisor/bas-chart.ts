// lib/revisor/bas-chart.ts
//
// BAS 2024 fallback account chart — used for the SIE-4 export's
// #KONTO entries when the customer's Fortnox doesn't return a custom
// chart or we can't reach the Fortnox /3/accounts endpoint at export
// time.
//
// Strategy:
//   1. Try Fortnox /3/accounts first (real chart, includes customer's
//      custom accounts).
//   2. If the customer has accounts not in their chart but referenced
//      in vouchers, this fallback supplies a generic description for
//      anything in the standard BAS 2024 range.
//   3. If a referenced account isn't in EITHER place, we still emit
//      the #KONTO line with description = "Konto {number}" so the
//      SIE file is structurally valid (revisor's tool will resolve).
//
// Covers the accounts a Swedish restaurant actually uses. Not the
// full ~1200-row BAS chart — that's overkill and noisy. Extend
// per-line when a customer's vouchers reference something missing.

export const BAS_2024_FALLBACK: Record<string, string> = {
  // ── 1xxx Assets ──────────────────────────────────────────────────
  '1010': 'Balanserade utgifter',
  '1110': 'Byggnader',
  '1119': 'Ackumulerade avskrivningar på byggnader',
  '1210': 'Maskiner och andra tekniska anläggningar',
  '1220': 'Inventarier och verktyg',
  '1229': 'Ackumulerade avskrivningar på inventarier',
  '1230': 'Installationer',
  '1240': 'Bilar och andra transportmedel',
  '1310': 'Andelar i koncernföretag',
  '1410': 'Lager av råvaror',
  '1460': 'Lager av varor',
  '1510': 'Kundfordringar',
  '1610': 'Kortfristiga fordringar hos anställda',
  '1630': 'Avräkning för skatter och avgifter (skattekonto)',
  '1640': 'Skattefordringar',
  '1650': 'Momsfordran',
  '1680': 'Andra kortfristiga fordringar',
  '1710': 'Förutbetalda hyreskostnader',
  '1730': 'Förutbetalda försäkringspremier',
  '1790': 'Övriga förutbetalda kostnader',
  '1910': 'Kassa',
  '1930': 'Företagskonto / Affärskonto',
  '1931': 'Företagskonto 2',
  '1940': 'Övriga bankkonton',
  '1950': 'Bankcertifikat',
  '1960': 'Skattekonto',
  '1970': 'Plusgiro',

  // ── 2xxx Liabilities + Equity ────────────────────────────────────
  '2010': 'Eget kapital',
  '2013': 'Privata uttag (enskild firma)',
  '2018': 'Övriga egna insättningar',
  '2019': 'Årets resultat',
  '2081': 'Aktiekapital',
  '2090': 'Fritt eget kapital',
  '2091': 'Balanserad vinst eller förlust',
  '2098': 'Vinst eller förlust från föregående år',
  '2099': 'Årets resultat',
  '2110': 'Periodiseringsfonder',
  '2150': 'Ackumulerade överavskrivningar',
  '2310': 'Obligations- och förlagslån',
  '2350': 'Andra långfristiga skulder',
  '2410': 'Andra kortfristiga låneskulder',
  '2440': 'Leverantörsskulder',
  '2510': 'Skatteskulder',
  '2611': 'Utgående moms på försäljning inom Sverige, 25 %',
  '2612': 'Utgående moms på försäljning inom Sverige, 12 %',
  '2613': 'Utgående moms på försäljning inom Sverige, 6 %',
  '2614': 'Utgående moms omvänd skattskyldighet, 25 %',
  '2615': 'Utgående moms import av varor, 25 %',
  '2616': 'Utgående moms VMB',
  '2618': 'Vilande utgående moms',
  '2620': 'Utgående moms, reducerad till 12 %',
  '2630': 'Utgående moms, reducerad till 6 %',
  '2640': 'Ingående moms',
  '2641': 'Debiterad ingående moms',
  '2642': 'Debiterad ingående moms i annat EU-land',
  '2645': 'Beräknad ingående moms på förvärv från utlandet',
  '2650': 'Redovisningskonto för moms',
  '2710': 'Personalskatt',
  '2730': 'Lagstadgade sociala avgifter och särskild löneskatt',
  '2731': 'Avräkning lagstadgade sociala avgifter',
  '2790': 'Övriga löneavdrag',
  '2811': 'Avräkning för factoring och belånade kontraktsfordringar',
  '2820': 'Kortfristiga skulder till anställda',
  '2830': 'Avräkning för annans räkning',
  '2841': 'Kortfristig del av långfristiga skulder',
  '2890': 'Övriga kortfristiga skulder',
  '2910': 'Upplupna löner',
  '2920': 'Upplupna semesterlöner',
  '2940': 'Upplupna lagstadgade sociala och andra avgifter',
  '2960': 'Upplupna räntekostnader',
  '2990': 'Övriga upplupna kostnader och förutbetalda intäkter',

  // ── 3xxx Revenue ─────────────────────────────────────────────────
  '3001': 'Försäljning inom Sverige 25 % moms',
  '3002': 'Försäljning inom Sverige 12 % moms',
  '3003': 'Försäljning inom Sverige 6 % moms',
  '3004': 'Försäljning inom Sverige momsfri',
  '3041': 'Försäljning tjänster inom Sverige 25 % moms',
  '3051': 'Försäljning varor till annat EU-land',
  '3105': 'Försäljning varor till land utanför EU',
  '3308': 'Försäljning catering / lunchkupong',
  '3540': 'Faktureringsavgifter',
  '3590': 'Övriga sidointäkter',
  '3740': 'Öres- och kronutjämning',
  '3960': 'Valutakursvinster på fordringar och skulder',

  // ── 4xxx Cost of goods sold ──────────────────────────────────────
  '4010': 'Inköp av varor / råvaror',
  '4011': 'Inköp alkohol',
  '4012': 'Inköp öl / cider',
  '4013': 'Inköp vin',
  '4014': 'Inköp sprit',
  '4015': 'Inköp förbrukningsmaterial',
  '4017': 'Inköp emballage / take-away',
  '4020': 'Inköp frukt och grönt',
  '4030': 'Inköp mejeri',
  '4040': 'Inköp kött',
  '4050': 'Inköp fisk och skaldjur',
  '4060': 'Inköp bröd',
  '4070': 'Inköp övriga livsmedel',
  '4090': 'Inköp övriga råvaror',
  '4115': 'Underentreprenörer (catering / event)',
  '4910': 'Förändring av lager varor',
  '4990': 'Övriga rörelsekostnader (kostnad sålda varor)',

  // ── 5xxx Premises + consumables ──────────────────────────────────
  '5010': 'Lokalhyra',
  '5070': 'Reparation och underhåll av lokal',
  '5090': 'Övriga lokalkostnader',
  '5130': 'Värme',
  '5170': 'Reparation och underhåll',
  '5220': 'Hyra av inventarier och verktyg',
  '5310': 'El för drift',
  '5320': 'Vatten och avlopp',
  '5410': 'Förbrukningsinventarier',
  '5460': 'Rengöringsmedel och städmaterial',
  '5510': 'Reparation och underhåll inventarier',
  '5611': 'Drivmedel personbil',
  '5710': 'Frakter och transporter',
  '5810': 'Biljetter',
  '5820': 'Hyrbilskostnader',
  '5830': 'Kost och logi',
  '5890': 'Övriga resekostnader',
  '5910': 'Annonsering',
  '5930': 'Reklamtryck och direktreklam',
  '5980': 'Övriga reklamkostnader',

  // ── 6xxx Other external costs ────────────────────────────────────
  '6071': 'Representation, avdragsgill',
  '6072': 'Representation, ej avdragsgill',
  '6110': 'Kontorsmateriel',
  '6212': 'Mobiltelefoni',
  '6230': 'Datakommunikation',
  '6250': 'Postbefordran',
  '6310': 'Företagsförsäkringar',
  '6420': 'Ersättning till revisor',
  '6450': 'Bolagsavgifter (Bolagsverket)',
  '6530': 'Redovisningstjänster',
  '6540': 'IT-tjänster',
  '6560': 'Serviceavgifter till branschorg.',
  '6570': 'Bankkostnader',
  '6590': 'Övriga köpta tjänster',
  '6810': 'Inkasso- och kreditupplysningstjänster',
  '6970': 'Tidningar, tidskrifter och facklitteratur',
  '6981': 'Föreningsavgifter, avdragsgilla',
  '6982': 'Föreningsavgifter, ej avdragsgilla',
  '6990': 'Övriga externa kostnader',
  '6991': 'Övriga externa kostnader, avdragsgilla',
  '6992': 'Övriga externa kostnader, ej avdragsgilla',

  // ── 7xxx Personnel costs ─────────────────────────────────────────
  '7010': 'Löner till kollektivanställda',
  '7012': 'Löner till tjänstemän och företagsledare',
  '7090': 'Förändring semesterlöneskuld',
  '7210': 'Löner ledig tid',
  '7281': 'Löner OB-tillägg',
  '7282': 'Övertidsersättning',
  '7332': 'Bilersättningar, skattefria',
  '7388': 'Personalkostnader, övriga',
  '7390': 'Övriga kostnadsersättningar och förmåner',
  '7510': 'Lagstadgade sociala avgifter',
  '7515': 'Sociala avgifter för förmånsvärden',
  '7519': 'Sociala avgifter för semesterlöneskuld',
  '7520': 'Särskild löneskatt på pensionskostnader',
  '7530': 'Avgifter till pensions- och försäkringsinstitut',
  '7570': 'Premier för arbetsmarknadsförsäkringar',
  '7610': 'Utbildning',
  '7620': 'Sjuk- och hälsovård',
  '7621': 'Företagshälsovård',
  '7690': 'Övriga personalkostnader',
  '7831': 'Avskrivningar på maskiner och inventarier',
  '7832': 'Avskrivningar på byggnader',

  // ── 8xxx Financial + tax ─────────────────────────────────────────
  '8010': 'Utdelning på andelar i koncernföretag',
  '8014': 'Ränteintäkter från koncernföretag',
  '8113': 'Räntebidrag',
  '8210': 'Resultat vid försäljning av värdepapper i andra företag',
  '8254': 'Ränteintäkter på skattekonto',
  '8310': 'Ränteintäkter, övriga',
  '8311': 'Ränteintäkter från bank',
  '8330': 'Valutakursvinster på kortfristiga fordringar och skulder',
  '8400': 'Räntekostnader',
  '8410': 'Räntekostnader, övriga',
  '8419': 'Övriga räntekostnader',
  '8423': 'Räntekostnader på skattekonto',
  '8490': 'Övriga finansiella kostnader',
  '8910': 'Skatter och avgifter',
  '8999': 'Årets resultat (balansposten)',
}

/**
 * Resolve a description for any BAS account number. Custom Fortnox
 * accounts (5-digit project codes etc.) get a generic placeholder so
 * the SIE file is valid even when the lookup misses.
 */
export function basAccountDescription(account: string | number): string {
  const key = String(account).trim()
  return BAS_2024_FALLBACK[key] ?? `Konto ${key}`
}
