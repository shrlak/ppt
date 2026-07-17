export interface CatalogAttempt {
  engine: 'gemini' | 'nvidia' | 'huggingface';
  model: string;
}

export interface SharedSettings {
  attempts: CatalogAttempt[];
  excludedTitles: string[];
}

export const RECOGNITION_MODEL_CATALOG: CatalogAttempt[];
export const DEFAULT_EXCLUDED_TITLES: string[];
export const DEFAULT_ADMIN_PASSWORD: string;
export const OPENROUTER_NEMOTRON_MODEL: string;

export function sanitizeAttemptOrder(raw: unknown): CatalogAttempt[];
export function sanitizeExcludedTitles(raw: unknown): string[];
export function sanitizeSharedSettings(raw: unknown): SharedSettings;
export function allowedOpenRouterModels(): Set<string>;
export function usageCatalogModels(
  env?: Record<string, string | undefined>,
): { provider: 'gemini' | 'openrouter' | 'huggingface'; model: string }[];
export function resolveOpenRouterRoute(requested: string): {
  configuredModel: string;
  upstreamModel: string;
};
export function adminPassword(env?: Record<string, string | undefined>): string;
