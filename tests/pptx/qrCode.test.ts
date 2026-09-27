import { describe, expect, it } from 'vitest';
import { QR_GAP, QR_SIZE, clearOfQrCodes, qrCodeBoxes, qrCodeGif, shapeRect } from '../../src/lib/pptx/qrCode';

const area = { right: 8748425, bottom: 6462425, top: 2104399 };

function bodyShape(x: number, y: number, cx: number, cy: number): string {
  return (
    `<p:sp><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></p:spPr>` +
    '<p:txBody><a:bodyPr lIns="91425" rIns="91425" tIns="45700" bIns="45700"/><a:p><a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc></a:pPr></a:p></p:txBody></p:sp>'
  );
}

describe('qrCodeGif', () => {
  it('draws a GIF large enough never to be scaled up', () => {
    const gif = qrCodeGif('https://forms.gle/xyz789');
    expect(new TextDecoder().decode(gif.slice(0, 4))).toBe('GIF8');
    const width = gif[6] | (gif[7] << 8);
    expect(width).toBeGreaterThanOrEqual(480);
    expect(gif[8] | (gif[9] << 8)).toBe(width);
  });

  it('encodes different links differently', () => {
    expect(qrCodeGif('https://forms.gle/a')).not.toEqual(qrCodeGif('https://forms.gle/b'));
  });
});

describe('qrCodeBoxes', () => {
  it('puts one code in the bottom-right corner', () => {
    expect(qrCodeBoxes(1, area)).toEqual([
      { x: area.right - QR_SIZE, y: area.bottom - QR_SIZE, cx: QR_SIZE, cy: QR_SIZE },
    ]);
  });

  it('stacks several up from the corner, the first link on top', () => {
    const [first, second] = qrCodeBoxes(2, area);
    expect(second.y + second.cy).toBe(area.bottom);
    expect(first.y + first.cy + QR_GAP).toBe(second.y);
    expect(first.x).toBe(second.x);
  });

  it('shrinks them alike when that many would not fit', () => {
    const boxes = qrCodeBoxes(4, area);
    expect(boxes[0].cx).toBeLessThan(QR_SIZE);
    expect(boxes[0].y).toBeGreaterThanOrEqual(area.top);
    expect(new Set(boxes.map((box) => box.cx)).size).toBe(1);
  });

  it('is empty without links', () => {
    expect(qrCodeBoxes(0, area)).toEqual([]);
  });
});

describe('clearOfQrCodes', () => {
  const shape = bodyShape(395525, 2104399, 8352900, 3730200);
  const boxes = qrCodeBoxes(1, area);

  function overlaps(a: { x: number; y: number; cx: number; cy: number }, b: typeof a): boolean {
    return a.x < b.x + b.cx && b.x < a.x + a.cx && a.y < b.y + b.cy && b.y < a.y + a.cy;
  }

  it('cuts a short text box off above the codes, keeping its full width', () => {
    const moved = shapeRect(clearOfQrCodes(shape, ['한 줄짜리 공지입니다.'], boxes, 2500, 1200))!;
    expect(moved.cx).toBe(8352900);
    expect(moved.y + moved.cy).toBe(boxes[0].y - QR_GAP);
    expect(overlaps(moved, boxes[0])).toBe(false);
  });

  it('narrows a full text box to the left of the codes when that keeps the text larger', () => {
    const lines = Array.from({ length: 7 }, (_, i) => `- ${i + 1}번째 안내: 짧은 항목`);
    const moved = shapeRect(clearOfQrCodes(shape, lines, boxes, 2500, 1200))!;
    expect(moved.cy).toBe(3730200);
    expect(moved.x + moved.cx).toBe(boxes[0].x - QR_GAP);
    expect(overlaps(moved, boxes[0])).toBe(false);
  });

  it('leaves a box that is already clear of the codes alone', () => {
    const high = bodyShape(395525, 2104399, 8352900, 1000000);
    expect(clearOfQrCodes(high, ['공지'], boxes, 2500, 1200)).toBe(high);
    expect(clearOfQrCodes(shape, ['공지'], [], 2500, 1200)).toBe(shape);
  });
});
