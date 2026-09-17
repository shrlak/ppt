// The 썸네일: the service's 표지 on its own, as a one-slide 16:9 file.
//
// It ships as its own asset (public/wednesday-thumbnail.pptx) rather than
// being cut out of the service template, because the cover was authored twice
// — once for the 4:3 service deck and once for the 16:9 thumbnail — and its
// text takes every offset and font size from its layout. Resizing the 4:3
// version would leave that layout behind and put the text in the wrong place.
import JSZip from 'jszip';
import { slideOrderOf } from '../lib/pptx/pptxSlices';
import { clearRemainingTokens, formatDateKo, substituteTokens } from './fields';
import type { WednesdayService } from './types';

export interface WednesdayThumbnailInput {
  /** public/wednesday-thumbnail.pptx. */
  template: ArrayBuffer | Uint8Array;
  service: WednesdayService;
  /** The passage as the deck spells it, e.g. "시편 18편 1-12절". */
  rangeKo: string;
}

export async function buildWednesdayThumbnail(input: WednesdayThumbnailInput): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(input.template);
  const names = await slideOrderOf(zip);
  if (names.length !== 1) {
    throw new Error(`썸네일 템플릿은 1장이어야 합니다 (${names.length}장).`);
  }

  const path = `ppt/slides/${names[0]}`;
  const xml = await zip.file(path)!.async('string');
  const { service } = input;
  zip.file(
    path,
    clearRemainingTokens(
      substituteTokens(xml, {
        DATE_KO: formatDateKo(service.date),
        SERMON_TITLE: service.sermonTitle.trim(),
        RANGE_KO: input.rangeKo,
        PREACHER: service.preacher.trim(),
        PREACHER_TITLE: service.preacherTitle.trim(),
      }),
    ),
  );

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** Download name for the thumbnail beside the deck's own MMDD.pptx. */
export function thumbnailFileName(deckFileName: string): string {
  return `${deckFileName.replace(/\.pptx$/i, '')} 썸네일.pptx`;
}
