import type { AdditionalFile, AdditionalFileKind } from './types';

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

export function detectAdditionalFileKind(name: string, bytes: Uint8Array): AdditionalFileKind {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (/\.pptx$/i.test(name) && startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'pptx';
  throw new Error(`${name}: 지원하지 않거나 손상된 파일입니다.`);
}

export function moveAdditionalFile(
  items: AdditionalFile[],
  id: string,
  delta: -1 | 1,
): AdditionalFile[] {
  const index = items.findIndex((item) => item.id === id);
  const destination = index + delta;
  if (index < 0 || destination < 0 || destination >= items.length) return items;
  const next = [...items];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}
