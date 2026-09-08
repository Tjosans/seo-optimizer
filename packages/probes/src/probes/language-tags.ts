/**
 * Whether a language tag is one a search engine will act on.
 *
 * `hreflang-cluster-qa` already asks whether a tag is *well formed*, which is a
 * question about syntax and answerable with a regex. This asks the different
 * question the corpus's 1.14 puts as "supported language-region codes": whether
 * the subtags name anything. `en-UK` is perfectly well formed and completely
 * ignored, because the United Kingdom is `GB`; a page annotated that way is not
 * partially targeted at Britain, it is not targeted at all.
 *
 * Answering that needs the lists themselves, which is why they are here. Both
 * are closed and slow-moving: ISO 639-1 for the language, ISO 3166-1 alpha-2
 * for the region. Script subtags (`zh-Hant`) are checked for shape only — ISO
 * 15924 is long, rarely wrong in the wild, and a bad script subtag degrades to
 * the language rather than being discarded.
 */

const set = (codes: string): ReadonlySet<string> => new Set(codes.split(' '));

/** ISO 639-1. The only language codes Google documents support for. */
const LANGUAGES = set(
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
    'da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu ' +
    'hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb ' +
    'lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om ' +
    'or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ' +
    'ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu',
);

/** ISO 3166-1 alpha-2. */
const REGIONS = set(
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR ' +
    'BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ ' +
    'EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW ' +
    'GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY ' +
    'KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV ' +
    'MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
    'QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG ' +
    'TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW',
);

/**
 * Codes ISO withdrew that are still typed from memory. Each is a silent
 * failure rather than a syntax error, so naming the replacement is the whole
 * value of noticing.
 */
const WITHDRAWN: Readonly<Record<string, string>> = {
  in: 'id',
  iw: 'he',
  ji: 'yi',
  mo: 'ro',
};

/** The region mistakes common enough to be worth answering rather than only reporting. */
const REGION_HINTS: Readonly<Record<string, string>> = {
  UK: 'the United Kingdom is "GB"',
  EL: 'Greece is "GR"',
  EU: 'the European Union is not a country, and hreflang has no code for it',
};

export interface LanguageTag {
  readonly language: string;
  readonly script: string | null;
  readonly region: string | null;
}

export type TagVerdict =
  | {
      readonly ok: true;
      readonly tag: LanguageTag;
      /** Supported enough to parse, not enough to rely on. */
      readonly warning?: string;
    }
  | { readonly ok: false; readonly problem: string };

const bad = (problem: string): TagVerdict => ({ ok: false, problem });

/**
 * Read one hreflang value.
 *
 * `x-default` is not a language tag and is the caller's business — this
 * rejects it like anything else, because a probe that fed it here would be
 * asking the wrong question.
 */
export function checkLanguageTag(value: string): TagVerdict {
  const raw = value.trim();
  if (raw === '') return bad('is empty');
  if (raw.includes('_')) return bad('separates its subtags with "_" where BCP 47 uses "-"');

  const parts = raw.split('-');
  let index = 0;

  const first = parts[index] ?? '';
  const language = first.toLowerCase();
  index += 1;
  if (!/^[a-z]{2,3}$/.test(language)) {
    return bad(`begins with "${first}", which is not a language subtag`);
  }

  const replacement = WITHDRAWN[language];
  if (replacement !== undefined) {
    return bad(`uses the withdrawn language code "${language}"; the current code is "${replacement}"`);
  }
  if (!LANGUAGES.has(language)) {
    // Country-first is the classic inversion: someone means "our British page"
    // and writes the country, which names either nothing or another language.
    const hint = REGIONS.has(language.toUpperCase())
      ? `; "${language.toUpperCase()}" is a country, and an hreflang value names a language first (for example "en-${language.toUpperCase()}")`
      : '';
    return bad(`names the language "${language}", which is not an ISO 639-1 code${hint}`);
  }

  let script: string | null = null;
  const maybeScript = parts[index];
  if (maybeScript !== undefined && /^[a-z]{4}$/i.test(maybeScript)) {
    script = maybeScript[0]!.toUpperCase() + maybeScript.slice(1).toLowerCase();
    index += 1;
  }

  let region: string | null = null;
  let warning: string | undefined;
  const maybeRegion = parts[index];
  if (maybeRegion !== undefined) {
    if (/^\d{3}$/.test(maybeRegion)) {
      // Well formed under BCP 47, and Google's documentation asks for alpha-2.
      region = maybeRegion;
      warning = `uses the UN M.49 region "${maybeRegion}"; search engines document support for ISO 3166-1 alpha-2 countries only`;
      index += 1;
    } else if (/^[a-z]{2}$/i.test(maybeRegion)) {
      const upper = maybeRegion.toUpperCase();
      index += 1;
      if (!REGIONS.has(upper)) {
        const hint = REGION_HINTS[upper];
        return bad(
          `names the region "${upper}", which is not an ISO 3166-1 alpha-2 country` +
            (hint === undefined ? '' : `; ${hint}`),
        );
      }
      region = upper;
    }
  }

  if (index < parts.length) {
    return bad(`carries the trailing subtag "${parts[index]}", which hreflang does not use`);
  }
  return warning === undefined
    ? { ok: true, tag: { language, script, region } }
    : { ok: true, tag: { language, script, region }, warning };
}
