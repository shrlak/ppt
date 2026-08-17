export function decodeHtmlEntities(text: string): string;
export function htmlToLines(html: string): string[];
export function isBoilerplateLine(line: string): boolean;
export function looksLikeLyricLine(line: string): boolean;
export function extractLyricBlock(lines: string[]): string[];
export function scoreLyricBlock(block: string[], title: string, pageText: string): number;
