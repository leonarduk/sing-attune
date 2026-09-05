import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { resolveFallbackTitle } from './title-fallback';

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

describe('resolveFallbackTitle (#698)', () => {
  it('never overrides when <work-title> is present, even with a larger-font credit', () => {
    const xml = `<?xml version="1.0"?>
      <score-partwise>
        <work><work-title>Amazing Grace</work-title></work>
        <credit page="1">
          <credit-type>title</credit-type>
          <credit-words font-size="12">Amazing Grace</credit-words>
        </credit>
        <credit page="1">
          <credit-type>lyricist</credit-type>
          <credit-words font-size="40">SOME BIG DECORATIVE TEXT</credit-words>
        </credit>
      </score-partwise>`;

    expect(resolveFallbackTitle(parse(xml))).toBeNull();
  });

  it('promotes the largest-font credit-words block when no work-title/movement-title signal is trustworthy', () => {
    // Mirrors musescore/homeward_bound.mxl (#698): both credit-type="title"
    // blocks carry no explicit font-size (so they don't look authoritative),
    // while the real title is mislabeled credit-type="lyricist" but printed
    // far larger than anything else on the page.
    const xml = `<?xml version="1.0"?>
      <score-partwise>
        <credit page="1">
          <credit-type>title</credit-type>
          <credit-words>for 2-part voices and piano</credit-words>
        </credit>
        <credit page="1">
          <credit-type>title</credit-type>
          <credit-words>with optional PianoTraX CD*</credit-words>
        </credit>
        <credit page="1">
          <credit-type>lyricist</credit-type>
          <credit-words font-size="23">HOMEWARD BOUND</credit-words>
        </credit>
        <credit page="1">
          <credit-type>composer</credit-type>
          <credit-words font-size="11">MARTA KEEN</credit-words>
        </credit>
      </score-partwise>`;

    const result = resolveFallbackTitle(parse(xml));
    expect(result).toEqual({ title: 'HOMEWARD BOUND', creditType: 'lyricist' });
  });

  it('does not override when the tagged title credit already carries the largest font-size', () => {
    const xml = `<?xml version="1.0"?>
      <score-partwise>
        <credit page="1">
          <credit-type>title</credit-type>
          <credit-words font-size="24">The Real Title</credit-words>
        </credit>
        <credit page="1">
          <credit-type>composer</credit-type>
          <credit-words font-size="11">Some Composer</credit-words>
        </credit>
      </score-partwise>`;

    expect(resolveFallbackTitle(parse(xml))).toBeNull();
  });

  it('returns null when no credit declares an explicit font-size at all', () => {
    const xml = `<?xml version="1.0"?>
      <score-partwise>
        <credit page="1">
          <credit-type>title</credit-type>
          <credit-words>Untitled Score</credit-words>
        </credit>
      </score-partwise>`;

    expect(resolveFallbackTitle(parse(xml))).toBeNull();
  });

  it('returns null when there are no credits at all', () => {
    const xml = `<?xml version="1.0"?><score-partwise></score-partwise>`;
    expect(resolveFallbackTitle(parse(xml))).toBeNull();
  });

  it('ignores credits on pages other than page 1', () => {
    const xml = `<?xml version="1.0"?>
      <score-partwise>
        <credit page="1">
          <credit-type>title</credit-type>
          <credit-words>Small Title</credit-words>
        </credit>
        <credit page="2">
          <credit-type>rights</credit-type>
          <credit-words font-size="40">Huge page-2 text</credit-words>
        </credit>
      </score-partwise>`;

    expect(resolveFallbackTitle(parse(xml))).toBeNull();
  });
});

describe('resolveFallbackTitle against the real musescore/homeward_bound.mxl fixture (#698)', () => {
  it('recovers "HOMEWARD BOUND" from the actual bundled file, not just synthetic XML', async () => {
    // This is the same real-world file the module docstring and #698 are
    // about (an Audiveris OMR scan re-exported via MuseScore). The unit
    // tests above pin the heuristic's *rules* against hand-built XML; this
    // test proves those rules actually fire correctly against the real
    // file's real (messier) MusicXML, not just an idealized excerpt of it.
    //
    // .mxl is a zip archive (MusicXML's compressed container format) whose
    // payload lives at score.xml (per META-INF/container.xml) — verified by
    // inspecting the archive directly. jszip is already a transitive
    // dependency of opensheetmusicdisplay (see frontend/package-lock.json),
    // so this reuses it rather than adding a new one just for this test.
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const mxlPath = resolve(currentDir, '../../../musescore/homeward_bound.mxl');
    const mxlBuffer = readFileSync(mxlPath);
    const zip = await JSZip.loadAsync(mxlBuffer);
    const xmlText = await zip.file('score.xml')?.async('string');
    expect(xmlText).toBeTruthy();

    const xmlDoc = parse(xmlText as string);
    const result = resolveFallbackTitle(xmlDoc);

    expect(result).toEqual({ title: 'HOMEWARD BOUND', creditType: 'lyricist' });
  });
});
