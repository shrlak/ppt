import { describe, expect, it } from 'vitest';
import { classifyPptxByName, routeUploadBatch, uploadRoleLabel } from '../../src/lib/utils/uploadRouter';

function file(name: string): File {
  return new File(['x'], name);
}

describe('classifyPptxByName', () => {
  it('recognizes Korean and English keywords for every template role', () => {
    expect(classifyPptxByName('설교_0712.pptx')).toBe('sermon');
    expect(classifyPptxByName('sunday-sermon.pptx')).toBe('sermon');
    expect(classifyPptxByName('표지템플릿.pptx')).toBe('front');
    expect(classifyPptxByName('front-slides-v2.pptx')).toBe('front');
    expect(classifyPptxByName('마무리슬라이드.pptx')).toBe('back');
    expect(classifyPptxByName('closing.pptx')).toBe('back');
    expect(classifyPptxByName('말씀템플릿.pptx')).toBe('bible');
    expect(classifyPptxByName('bible-template.pptx')).toBe('bible');
  });

  it('returns null when nothing matches', () => {
    expect(classifyPptxByName('untitled.pptx')).toBeNull();
  });

  it('checks bible/front/back before the generic sermon fallback so those never get misread as sermons', () => {
    // Would match "front" AND could plausibly be misread if order were reversed.
    expect(classifyPptxByName('예배시작표지.pptx')).toBe('front');
  });
});

describe('routeUploadBatch', () => {
  it('routes a mixed batch: the pdf becomes conti, each pptx keeps its own row', () => {
    const files = [file('conti-0712.pdf'), file('설교.pptx'), file('표지템플릿.pptx'), file('마무리.pptx')];
    const routed = routeUploadBatch(files);

    expect(routed.map((r) => r.role)).toEqual(['conti', 'sermon', 'front', 'back']);
    expect(routed.every((r) => r.confident)).toBe(true);
  });

  it('only takes the first pdf when several are dropped', () => {
    const routed = routeUploadBatch([file('a.pdf'), file('b.pdf')]);
    expect(routed).toHaveLength(1);
    expect(routed[0].file.name).toBe('a.pdf');
  });

  it('falls back an unrecognized pptx name to sermon, flagged as unconfident', () => {
    const routed = routeUploadBatch([file('untitled.pptx')]);
    expect(routed).toEqual([{ file: expect.objectContaining({ name: 'untitled.pptx' }), role: 'sermon', confident: false }]);
  });

  it('ignores files that are neither a pdf nor a pptx', () => {
    const routed = routeUploadBatch([file('notes.txt'), file('image.png')]);
    expect(routed).toHaveLength(0);
  });

  it('gives every template role a Korean label', () => {
    expect(uploadRoleLabel('conti')).toBe('찬양 콘티');
    expect(uploadRoleLabel('sermon')).toBe('설교 PPT');
    expect(uploadRoleLabel('front')).toBe('Front 템플릿');
    expect(uploadRoleLabel('back')).toBe('Back 템플릿');
    expect(uploadRoleLabel('bible')).toBe('성경 말씀 템플릿');
  });
});
