export type ModelRole = 'champion' | 'challenger' | 'paused';

export interface CatalogAttempt {
  engine: 'gemini' | 'openrouter';
  model: string;
  upstreamModel: string;
  role: ModelRole;
}

export interface SharedSettings {
  attempts: { engine: 'gemini' | 'openrouter'; model: string }[];
  excludedTitles: string[];
  confessionSong: string;
  roleOverrides: Partial<Record<string, ModelRole>>;
}

export const RECOGNITION_MODEL_CATALOG: CatalogAttempt[];
export const DEFAULT_EXCLUDED_TITLES: string[];
export const DEFAULT_CONFESSION_SONG: string;
export const DEFAULT_ADMIN_PASSWORD: string;
export const OPENROUTER_NEMOTRON_MODEL: string;

export function migrateEngineName(value: unknown): 'gemini' | 'openrouter' | undefined;
export function isFreeVisionCatalogEntry(entry: CatalogAttempt): boolean;
export function sanitizeAttemptOrder(raw: unknown): { engine: 'gemini' | 'openrouter'; model: string }[];
export function sanitizeExcludedTitles(raw: unknown): string[];
export function sanitizeConfessionSong(raw: unknown): string;
export function sanitizeRoleOverrides(raw: unknown): Partial<Record<string, ModelRole>>;
export function sanitizeSharedSettings(raw: unknown): SharedSettings;
export function allowedOpenRouterModels(): Set<string>;
export function usageCatalogModels(): { provider: 'gemini' | 'openrouter'; model: string }[];
export function resolveOpenRouterRoute(
  requested: string,
): { configuredModel: string; upstreamModel: string } | null;
export function adminPassword(env?: Record<string, string | undefined>): string;
