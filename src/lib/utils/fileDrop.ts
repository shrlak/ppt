/**
 * Reading an OS drag, apart from any component.
 *
 * 콘티는 업로드 상자뿐 아니라 창 어디에 놓아도 열린다. 그 판단(파일을 끌어온
 * 드래그인가, 그중 어느 것이 콘티 PDF인가)만 따로 떼어 두어 브라우저 없이도
 * 검증할 수 있게 한다.
 */

/** The `DataTransfer` fields a drop decision actually reads. */
export interface DropData {
  types?: readonly string[] | DOMStringList;
  files?: ArrayLike<File> | null;
}

/**
 * True only for a drag carrying files in from outside the page — dragged text,
 * links and in-page reordering all leave the window-wide handler alone.
 */
export function dragCarriesFiles(transfer: DropData | null | undefined): boolean {
  if (!transfer?.types) return false;
  return Array.from(transfer.types as ArrayLike<string>).includes('Files');
}

/** A conti is a PDF; browsers that send no MIME type still send the name. */
export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export type ContiDrop =
  /** The 콘티 to open — the first PDF, so a PDF dropped with stray files still lands. */
  | { kind: 'pdf'; file: File }
  /** Files were dropped, none of them a PDF: worth saying so rather than ignoring. */
  | { kind: 'unsupported'; names: string[] }
  /** Nothing droppable (an empty transfer, or a drag that carried no files). */
  | { kind: 'empty' };

export function readContiDrop(files: ArrayLike<File> | null | undefined): ContiDrop {
  const dropped = files ? Array.from(files) : [];
  if (dropped.length === 0) return { kind: 'empty' };
  const pdf = dropped.find(isPdfFile);
  if (pdf) return { kind: 'pdf', file: pdf };
  return { kind: 'unsupported', names: dropped.map((file) => file.name) };
}
