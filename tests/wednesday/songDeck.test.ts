import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { slideOrderOf } from '../../src/lib/pptx/pptxSlices';
import { hasSheetMusic, inspectSongDeck, prepareSongDeck, removeSongBackgrounds } from '../../src/wednesday/songDeck';
import {
  PHOTO_BACKGROUND,
  SIZE,
  deckOf,
  group,
  jumpButton,
  lyricsSlides,
  picture,
  sheetSlides,
  textBox,
} from '../support/songDeckFixtures';

async function slideXml(deck: Uint8Array, number: number): Promise<string> {
  return (await JSZip.loadAsync(deck)).file(`ppt/slides/slide${number}.xml`)!.async('string');
}

/** The slides a deck shows, in order, as their part names. */
async function shownSlides(deck: Uint8Array): Promise<string[]> {
  return slideOrderOf(await JSZip.loadAsync(deck));
}

/**
 * A 악보 PPT the way they are shared: a photo sent to the back, the 악보
 * page, the song's title over it, and 1절·후렴·브릿지 buttons along the
 * bottom that jump between slides, with the blog's logo in a corner.
 */
function decoratedSheetSlides(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    shapes: [
      picture('rIdPhoto'),
      picture('rIdSheet', { x: 600000, y: 300000, cx: 7900000, cy: 5700000 }),
      textBox('주님의 선하심', { color: 'FFFFFF' }),
      jumpButton('1절', 'rIdJump1', 500000),
      jumpButton('후렴', 'rIdJump2', 1500000),
      picture('rIdLogo', { x: 8300000, y: 6100000, cx: 600000, cy: 600000 }),
    ],
    media: { rIdPhoto: 'photo.jpg', rIdSheet: `sheet${index + 1}.png`, rIdLogo: 'logo.png' },
    jumps: { rIdJump1: 1, rIdJump2: count },
  }));
}

describe('telling a 악보 PPT from a 가사 PPT', () => {
  it('takes a deck whose slides carry the 악보 as pictures', async () => {
    expect(await hasSheetMusic(await deckOf(sheetSlides(4)))).toBe(true);
    // A title slide and a blank end slide do not make it a 가사 PPT.
    expect(
      await hasSheetMusic(await deckOf([{ shapes: [textBox('주님의 선하심')] }, ...sheetSlides(3), { shapes: [] }])),
    ).toBe(true);
    // Sheets cut into lines, a few to a slide.
    const line = (y: number) => picture('rId2', { x: 400000, y, cx: 8300000, cy: 1000000 });
    expect(await hasSheetMusic(await deckOf([{ shapes: [line(500000), line(3000000)], media: { rId2: 'line.png' } }]))).toBe(
      true,
    );
  });

  it('refuses a deck of 가사 only, whatever is behind it', async () => {
    expect(await hasSheetMusic(await deckOf(lyricsSlides(4)))).toBe(false);
    // The photo inserted as a picture and sent to the back, the same on every slide.
    const photoUnder = Array.from({ length: 4 }, (_, index) => ({
      shapes: [picture('rId2'), textBox(`가사 ${index + 1}`)],
      media: { rId2: 'photo.jpg' },
    }));
    expect(await hasSheetMusic(await deckOf(photoUnder))).toBe(false);
    // A small logo in the corner is not a 악보.
    const logo = Array.from({ length: 4 }, () => ({
      shapes: [textBox('가사'), picture('rId2', { x: 8000000, y: 6000000, cx: 600000, cy: 600000 })],
      media: { rId2: 'logo.png' },
    }));
    expect(await hasSheetMusic(await deckOf(logo))).toBe(false);
  });
});

describe('taking a song PPT\'s background off', () => {
  it('puts every slide on plain white with nothing of the master behind it', async () => {
    const deck = await removeSongBackgrounds(await deckOf(lyricsSlides(2)));
    const xml = await slideXml(deck, 1);
    expect(xml).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>');
    expect(xml).not.toContain('rIdBg');
    expect(xml).toMatch(/<p:sld showMasterSp="0" /);
    // Text is read as on a white slide, whatever the master's colours were.
    expect(xml).toContain('<a:overrideClrMapping bg1="lt1" tx1="dk1"');
    expect(xml).not.toContain('masterClrMapping');
  });

  it('keeps the 악보, even when it is the only thing on a slide', async () => {
    const deck = await removeSongBackgrounds(await deckOf(sheetSlides(3)));
    for (const number of [1, 2, 3]) {
      const xml = await slideXml(deck, number);
      expect(xml).toContain('<a:blip r:embed="rId2"/>');
      expect(xml).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/>');
    }
    expect(await hasSheetMusic(deck)).toBe(true);
  });

  it('takes out a photo sent to the back of every slide, and leaves the 악보 on it', async () => {
    const slides = Array.from({ length: 3 }, (_, index) => ({
      shapes: [picture('rIdPhoto'), picture('rIdSheet', { x: 300000, y: 300000, cx: 8500000, cy: 6200000 })],
      media: { rIdPhoto: 'photo.jpg', rIdSheet: `sheet${index + 1}.png` },
    }));
    const deck = await removeSongBackgrounds(await deckOf(slides));
    const xml = await slideXml(deck, 2);
    expect(xml).not.toContain('r:embed="rIdPhoto"');
    expect(xml).toContain('r:embed="rIdSheet"');
  });

  it('keeps a 악보 page set as the slide\'s own background, as a picture on the slide', async () => {
    // "배경 서식 → 그림" with a different page on each slide is the 악보 itself.
    const slides = Array.from({ length: 2 }, (_, index) => ({
      background: PHOTO_BACKGROUND,
      shapes: [],
      media: { rIdBg: `page${index + 1}.png` },
    }));
    const original = await deckOf(slides);
    expect(await hasSheetMusic(original)).toBe(true);

    const xml = await slideXml(await removeSongBackgrounds(original), 1);
    expect(xml).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/>');
    expect(xml).toMatch(/<p:pic><p:nvPicPr><p:cNvPr id="\d+" name="악보"\/>[\s\S]*r:embed="rIdBg"/);
    expect(xml).toContain(`<a:ext cx="${SIZE.cx}" cy="${SIZE.cy}"/>`);
  });

  it('makes white text black where it sits on the slide, but not inside a filled button', async () => {
    const deck = await removeSongBackgrounds(
      await deckOf([
        {
          shapes: [
            picture('rId2'),
            textBox('주님의 선하심', { color: 'FFFFFF' }),
            textBox('1절', { fill: '1F3864', color: 'FFFFFF' }),
          ],
          media: { rId2: 'sheet.png' },
        },
      ]),
    );
    const xml = await slideXml(deck, 1);
    const title = xml.match(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*주님의 선하심[\s\S]*?<\/p:sp>/)![0];
    const button = xml.match(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*1절[\s\S]*?<\/p:sp>/)![0];
    expect(title).toContain('<a:rPr lang="ko-KR" sz="4000"><a:solidFill><a:srgbClr val="000000"/>');
    // The outline is a line, not the text, and stays as it was.
    expect(title).toContain('<a:ln><a:solidFill><a:srgbClr val="FFFFFF"/>');
    expect(button).toContain('<a:rPr lang="ko-KR" sz="4000"><a:solidFill><a:srgbClr val="FFFFFF"/>');
  });
});

describe('putting a song PPT in with its 악보 alone', () => {
  it('keeps the 악보 and takes off the background, the title, the buttons along the bottom and the logo', async () => {
    const { data, slideCount } = await prepareSongDeck(await deckOf(decoratedSheetSlides(3)));
    expect(slideCount).toBe(3);
    const xml = await slideXml(data, 2);
    expect(xml).toContain('r:embed="rIdSheet"');
    expect(xml).not.toContain('rIdPhoto');
    expect(xml).not.toContain('rIdLogo');
    expect(xml).not.toContain('<p:sp>');
    expect(xml).not.toContain('주님의 선하심');
    expect(xml).not.toContain('후렴');
    expect(xml).not.toContain('hlinkClick');
    expect(xml).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/>');
    expect(xml).toMatch(/<p:sld showMasterSp="0" /);

    const zip = await JSZip.loadAsync(data);
    const rels = await zip.file('ppt/slides/_rels/slide2.xml.rels')!.async('string');
    // The buttons' jumps went with the buttons, and so did the pictures nothing shows.
    expect(rels).not.toContain('relationships/slide"');
    expect(rels).toContain('sheet2.png');
    expect(rels).not.toContain('photo.jpg');
    expect(zip.file('ppt/media/photo.jpg')).toBeNull();
    expect(zip.file('ppt/media/logo.png')).toBeNull();
    expect(zip.file('ppt/media/sheet2.png')).not.toBeNull();
  });

  it('drops a slide left with no 악보 on it, such as the title slide or a blank one at the end', async () => {
    const deck = await deckOf([{ shapes: [textBox('주님의 선하심')] }, ...sheetSlides(2), { shapes: [] }]);
    expect(await inspectSongDeck(deck)).toEqual({ sheetMusic: true, slideCount: 2 });

    const { data, slideCount } = await prepareSongDeck(deck);
    expect(slideCount).toBe(2);
    expect(await shownSlides(data)).toEqual(['slide2.xml', 'slide3.xml']);
    const zip = await JSZip.loadAsync(data);
    expect(zip.file('ppt/slides/slide1.xml')).toBeNull();
    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).not.toContain('/ppt/slides/slide1.xml');
    expect(types).toContain('/ppt/slides/slide2.xml');
  });

  it('keeps every line of a 악보 cut into lines, a few to a slide', async () => {
    const line = (y: number) => picture('rIdLine', { x: 400000, y, cx: 8300000, cy: 1000000 });
    const { data } = await prepareSongDeck(
      await deckOf([
        { shapes: [line(500000), line(3000000), jumpButton('1절', 'rIdJump', 500000)], media: { rIdLine: 'line.png' }, jumps: { rIdJump: 1 } },
      ]),
    );
    const xml = await slideXml(data, 1);
    expect(xml.match(/r:embed="rIdLine"/g)).toHaveLength(2);
    expect(xml).not.toContain('1절');
  });

  it('keeps only the pictures of a group that holds the 악보', async () => {
    const { data } = await prepareSongDeck(
      await deckOf(
        Array.from({ length: 2 }, () => ({
          shapes: [group([picture('rIdSheet'), textBox('© 찬양팀')])],
          media: { rIdSheet: 'sheet.png' },
        })),
      ),
    );
    const xml = await slideXml(data, 1);
    expect(xml).toContain('<p:grpSp>');
    expect(xml).toContain('r:embed="rIdSheet"');
    expect(xml).not.toContain('찬양팀');
  });

  it('keeps a 악보 page set as the slide\'s own background, and nothing else', async () => {
    const slides = Array.from({ length: 2 }, (_, index) => ({
      background: PHOTO_BACKGROUND,
      shapes: [textBox(`${index + 1}절`)],
      media: { rIdBg: `page${index + 1}.png` },
    }));
    const { data, slideCount } = await prepareSongDeck(await deckOf(slides));
    expect(slideCount).toBe(2);
    const xml = await slideXml(data, 1);
    expect(xml).toMatch(/<p:pic><p:nvPicPr><p:cNvPr id="\d+" name="악보"\/>[\s\S]*r:embed="rIdBg"/);
    expect(xml).not.toContain('1절');
  });

  it('does not take a 악보 page repeated under the buttons for a background photo', async () => {
    // The chorus page on most slides, as when a slide is duplicated for each 후렴.
    const slides = [1, 2, 2, 2].map((page) => ({
      shapes: [picture('rIdSheet'), jumpButton('후렴', 'rIdJump', 500000)],
      media: { rIdSheet: `page${page}.png` },
      jumps: { rIdJump: 2 },
    }));
    const { data, slideCount } = await prepareSongDeck(await deckOf(slides));
    expect(slideCount).toBe(4);
    expect(await slideXml(data, 3)).toContain('r:embed="rIdSheet"');
  });

  it('leaves a deck with no 악보 whole, taking off only its background', async () => {
    const deck = await deckOf(lyricsSlides(3));
    expect(await inspectSongDeck(deck)).toEqual({ sheetMusic: false, slideCount: 3 });
    const { data, slideCount } = await prepareSongDeck(deck);
    expect(slideCount).toBe(3);
    const xml = await slideXml(data, 1);
    expect(xml).toContain('가사 1');
    expect(xml).not.toContain('rIdBg');
  });
});
