export type AdditionalFileKind = 'pdf' | 'pptx' | 'png' | 'jpeg';

export interface AdditionalFile {
  id: string;
  name: string;
  kind: AdditionalFileKind;
  data: ArrayBuffer;
  slideCount: number;
}

export const SUPPORTED_ADDITIONAL_ACCEPT = '.pdf,.pptx,.png,.jpg,.jpeg';
