import { ValidationError } from '../middleware/validate.js';

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginationMeta {
  total?: number;
  limit: number;
  offset: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Returns true if the string is absent or empty (treat as "use default").
 * Returns false if the string is present but not a valid non-negative integer.
 * Throws ValidationError for present-but-invalid values.
 */
function parseIntParam(
  raw: string | undefined,
  field: string,
  { min, max }: { min?: number; max?: number } = {},
): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  const trimmed = raw.trim();
  // Must be a string of digits only (no sign, no decimal, no exponent)
  if (!/^\d+$/.test(trimmed)) {
    throw new ValidationError([
      { field: `query.${field}`, message: `${field} must be a non-negative integer`, code: 'INVALID_VALUE' },
    ]);
  }

  const value = parseInt(trimmed, 10);

  if (min !== undefined && value < min) {
    throw new ValidationError([
      { field: `query.${field}`, message: `${field} must be >= ${min}`, code: 'INVALID_VALUE' },
    ]);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError([
      { field: `query.${field}`, message: `${field} must be <= ${max}`, code: 'INVALID_VALUE' },
    ]);
  }

  return value;
}

/**
 * Parses and strictly validates pagination query parameters.
 *
 * - `limit`: optional non-negative integer, clamped to [1, MAX_LIMIT]. Defaults to DEFAULT_LIMIT.
 * - `offset`: optional non-negative integer. Defaults to 0.
 * - `page`: optional non-negative integer >= 1. When present, takes precedence over `offset`.
 *
 * Throws a ValidationError (400) when a supplied value is non-integer or negative.
 */
export function parsePagination(query: {
  limit?: string;
  offset?: string;
  page?: string;
}): PaginationParams {
  const rawLimit = parseIntParam(query.limit, 'limit', { min: 1 });
  const limit = rawLimit !== undefined ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  let offset = 0;
  if (query.page !== undefined && query.page.trim() !== '') {
    const page = parseIntParam(query.page, 'page', { min: 1 }) ?? 1;
    offset = (page - 1) * limit;
  } else {
    offset = parseIntParam(query.offset, 'offset', { min: 0 }) ?? 0;
  }

  return { limit, offset };
}

export function paginatedResponse<T>(
  data: T[],
  meta: PaginationMeta,
): PaginatedResponse<T> {
  // Performance optimization: truncate large lists in-place to reduce allocations.
  // Setting length is faster than slice() as it avoids creating a new array.
  if (data.length > meta.limit) {
    data.length = meta.limit;
  }
  return { data, meta };
}
