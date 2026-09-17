import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  readSlideSize,
  rescaleDeckToSize,
  sameSlideSize,
  scaleSlideXml,
  slideScaleFor,
} from '../../src/lib/pptx/slideGeometry';
import { assertPptxIntegrity } from '../../src/lib/pptx/pptxPackage';

const publicDir = join(__dirname, '..', '..', 'public');
const wednesdayTemplate = readFileSync(join(publicDir, 'wednesday-template.pptx'));
const wednesdayThumbnail = readFileSync(join(publicDir, 'wednesday-thumbnail.pptx'));

const WEDNESDAY = { cx: 13004800, cy: 9753600 };
const WIDESCREEN = { cx: 12192000, cy: 6858000 };

/** A slide shaped like a 찬양 PPT page: full-bleed picture plus a grouped button. */
const songSlideXml = [
  '<p:sld><p:cSld><p:spTree>',
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/></p:nvGrpSpPr>',
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:grpSpPr>',
  '<p:pic><p:nvPicPr><p:cNvPr id="2" name="악보"/></p:nvPicPr>',
  '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm></p:spPr></p:pic>',
  '<p:sp><p:nvSpPr><p:cNvPr id="3" name="AutoShape"/></p:nvSpPr>',
  '<p:spPr><a:xfrm><a:off x="400000" y="6000000"/><a:ext cx="3000000" cy="300000"/></a:xfrm></p:spPr>',
  '<p:txBody><a:p><a:r><a:rPr lang="ko-KR" sz="2000"/><a:t>1절</a:t></a:r></a:p></p:txBody></p:sp>',
  '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="묶음"/></p:nvGrpSpPr>',
  '<p:grpSpPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="2000000"/>',
  '<a:chOff x="0" y="0"/><a:chExt cx="2000000" cy="2000000"/></a:xfrm></p:grpSpPr>',
  '<p:sp><p:nvSpPr><p:cNvPr id="5" name="자식"/></p:nvSpPr>',
  '<p:spPr><a:xfrm><a:off x="500000" y="500000"/><a:ext cx="500000" cy="500000"/></a:xfrm></p:spPr></p:sp>',
  '</p:grpSp>',
  '</p:spTree></p:cSld></p:sld>',
].join('');

describe('readSlideSize', () => {
  it('reads each Wednesday asset\'s own canvas', async () => {
    expect(await readSlideSize(wednesdayTemplate)).toEqual(WEDNESDAY);
    expect(await readSlideSize(wednesdayThumbnail)).toEqual(WIDESCREEN);
    expect(sameSlideSize(WEDNESDAY, WIDESCREEN)).toBe(false);
  });
});

describe('slideScaleFor', () => {
  it('fits the smaller axis and centres what is left over', () => {
    const scale = slideScaleFor(WIDESCREEN, WEDNESDAY);
    // Width is the binding axis (1.0667×) — scaling by height would crop.
    expect(scale.scale).toBeCloseTo(13004800 / 12192000, 10);
    expect(scale.offsetX).toBe(0);
    // 16:9 content on a 4:3 canvas leaves equal bands top and bottom.
    expect(scale.offsetY).toBe(Math.round((9753600 - 6858000 * scale.scale) / 2));
  });

  it('shrinks when the target canvas is smaller', () => {
    const scale = slideScaleFor(WEDNESDAY, WIDESCREEN);
    expect(scale.scale).toBeLessThan(1);
    expect(scale.offsetY).toBe(0);
    expect(scale.offsetX).toBeGreaterThan(0);
  });
});

describe('scaleSlideXml', () => {
  const scale = slideScaleFor(WIDESCREEN, WEDNESDAY);
  const scaled = scaleSlideXml(songSlideXml, scale);

  it('grows the full-bleed picture to the new canvas width', () => {
    expect(scaled).toContain(`<a:ext cx="13004800" cy="${Math.round(6858000 * scale.scale)}"/>`);
    expect(scaled).toContain(`<a:off x="0" y="${scale.offsetY}"/>`);
  });

  it('moves and scales a top-level shape, and its font size with it', () => {
    expect(scaled).toContain(`x="${Math.round(400000 * scale.scale)}"`);
    expect(scaled).toContain(`y="${Math.round(6000000 * scale.scale) + scale.offsetY}"`);
    expect(scaled).toContain(`sz="${Math.round((2000 * scale.scale) / 100) * 100}"`);
  });

  it('leaves group children in their own coordinate space', () => {
    // The group's transform maps its children, so scaling them too would
    // apply the factor twice.
    expect(scaled).toContain('<a:off x="500000" y="500000"/>');
    expect(scaled).toContain('<a:chExt cx="2000000" cy="2000000"/>');
    // The group itself moved.
    expect(scaled).toContain(`<a:off x="${Math.round(1000000 * scale.scale)}" y="${Math.round(1000000 * scale.scale) + scale.offsetY}"/>`);
  });

  it('leaves the tree\'s own group transform alone', () => {
    expect(scaled).toContain('<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:grpSpPr>');
  });
});

describe('rescaleDeckToSize', () => {
  it('rescales a deck authored at another size and records where it came from', async () => {
    const result = await rescaleDeckToSize(wednesdayThumbnail, WEDNESDAY);
    expect(result.rescaled).toBe(true);
    expect(result.from).toEqual(WIDESCREEN);

    const zip = await JSZip.loadAsync(result.data);
    const presentation = await zip.file('ppt/presentation.xml')!.async('string');
    expect(presentation).toContain(`cx="${WEDNESDAY.cx}"`);
    expect(presentation).toContain(`cy="${WEDNESDAY.cy}"`);
    await expect(assertPptxIntegrity(result.data)).resolves.toBeUndefined();
  });

  it('returns a deck that is already the right size untouched', async () => {
    const result = await rescaleDeckToSize(wednesdayTemplate, WEDNESDAY);
    expect(result.rescaled).toBe(false);
    expect(result.data.byteLength).toBe(wednesdayTemplate.byteLength);
  });
});
