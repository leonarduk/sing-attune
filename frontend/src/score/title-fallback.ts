/**
 * Fallback title-detection heuristic for MusicXML files whose title
 * metadata is missing or unreliable.
 *
 * Background (#698): musescore/homeward_bound.mxl (an Audiveris OMR scan
 * re-exported via MuseScore) has no <work><work-title>, and every other
 * place OSMD or our backend could read a title from is *also* wrong:
 *   - <movement-title> contains a CD-blurb ("with optional PianoTraX CD*"),
 *     not the song title.
 *   - Both <credit-type>title</credit-type> blocks on the title page are
 *     also not the song title.
 *   - The credit block that actually reads "HOMEWARD BOUND" is mislabeled
 *     credit-type="lyricist" — but it is rendered in font-size 23, the
 *     largest text on the title page (everything else is 9-11).
 *
 * A human looking at the rendered title page picks out the title by how
 * large it's printed, not by trusting the file's (possibly wrong)
 * credit-type/movement-title metadata. This module encodes that same
 * signal generally — it is not specific to this file or to "HOMEWARD
 * BOUND" — so any similarly mislabeled/OMR-exported score benefits.
 *
 * Deliberately conservative: <work-title> is treated as fully trusted and
 * is never overridden, and the heuristic only fires when the file's own
 * credit-type="title" block(s) do *not* carry the largest explicit
 * font-size on the title page — i.e. only when that metadata already looks
 * suspicious by the same font-size signal. A well-formed file whose title
 * credit genuinely is the largest text on the page is left untouched.
 */

export interface FallbackTitleResult {
  /** The text to use as the score title. */
  title: string;
  /**
   * The (possibly wrong) credit-type the promoted text was actually tagged
   * with in the source file, e.g. "lyricist" for homeward_bound.mxl. Lets
   * the caller suppress that credit line so the promoted title doesn't also
   * get drawn a second time under its original, mislabeled role.
   */
  creditType: string | null;
}

interface CreditCandidate {
  text: string;
  fontSize: number;
  creditType: string | null;
}

function creditWordsOf(credit: Element): Element[] {
  return Array.from(credit.getElementsByTagName('credit-words'));
}

function textOf(credit: Element): string {
  return creditWordsOf(credit)
    .map((words) => words.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Largest explicit font-size among a credit's <credit-words> children, or
 * null if none declares one. Credits without an explicit size are ignored
 * by the heuristic below rather than assumed to be some default size —
 * MusicXML doesn't guarantee a document-wide default, and guessing one
 * risks false positives on ordinary files that just don't bother setting
 * font-size at all.
 */
function maxFontSize(credit: Element): number | null {
  let max: number | null = null;
  for (const words of creditWordsOf(credit)) {
    const attr = words.getAttribute('font-size');
    if (!attr) continue;
    const parsed = parseFloat(attr);
    if (Number.isNaN(parsed)) continue;
    if (max === null || parsed > max) max = parsed;
  }
  return max;
}

/**
 * Decide whether the largest-font-credit fallback should override the
 * title OSMD would otherwise draw for this MusicXML document, and if so,
 * with what.
 *
 * Returns null when:
 *   - a <work-title> is present (trusted structured source, never
 *     second-guessed), or
 *   - there's no page-1 credit with an explicit font-size to compare
 *     against (not enough signal to justify overriding anything), or
 *   - the file's own credit-type="title" block(s) already carry the
 *     largest explicit font-size on the page (the common well-formed case
 *     — nothing looks wrong, so leave OSMD's normal title resolution
 *     alone).
 */
export function resolveFallbackTitle(xmlDoc: Document): FallbackTitleResult | null {
  const workTitle = xmlDoc.querySelector('work > work-title')?.textContent?.trim();
  if (workTitle) return null;

  const page1Credits = Array.from(xmlDoc.getElementsByTagName('credit')).filter(
    (credit) => (credit.getAttribute('page') ?? '1') === '1',
  );

  let bestOverall: CreditCandidate | null = null;
  let titleTypeMaxFontSize: number | null = null;

  for (const credit of page1Credits) {
    const fontSize = maxFontSize(credit);
    if (fontSize === null) continue;

    const text = textOf(credit);
    if (!text) continue;

    const creditType = credit.querySelector('credit-type')?.textContent?.trim() ?? null;

    if (creditType === 'title') {
      titleTypeMaxFontSize = titleTypeMaxFontSize === null ? fontSize : Math.max(titleTypeMaxFontSize, fontSize);
    }

    if (!bestOverall || fontSize > bestOverall.fontSize) {
      bestOverall = { text, fontSize, creditType };
    }
  }

  if (!bestOverall) return null;

  // The tagged title already is (one of) the largest things on the page —
  // trust it rather than promoting something else with the same font size
  // or smaller.
  if (titleTypeMaxFontSize !== null && titleTypeMaxFontSize >= bestOverall.fontSize) {
    return null;
  }

  return { title: bestOverall.text, creditType: bestOverall.creditType };
}
