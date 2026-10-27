import type { TListFilters } from '@board-platform/contracts/types/protocol/list';
import { BadRequestException } from '@nestjs/common';

export interface IPlatformListQuery {
  pageSize: number;
  pageNum: number;
  sort: string;
  filters: TListFilters;
}

/** Parse the bounded list wire format used by platform administration tables. */
export function parsePlatformListQuery(input: {
  pageSize?: string;
  pageNum?: string;
  sort?: string;
  filters?: string | Record<string, unknown>;
}): IPlatformListQuery {
  const pageSize = parsePositiveInt(input.pageSize, 50, 200);
  const pageNum = parsePositiveInt(input.pageNum, 1);
  const offset = (pageNum - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    throw new BadRequestException('pagination offset is too large');
  }
  return {
    pageSize,
    pageNum,
    sort: input.sort?.trim() ?? '',
    filters: parseFilters(input.filters),
  };
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  maximum?: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new BadRequestException(
      'pagination values must be positive integers',
    );
  }
  return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function parseFilters(
  input: string | Record<string, unknown> | undefined,
): TListFilters {
  if (input === undefined) return {};
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new BadRequestException('filters must be valid JSON');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('filters must be a JSON object');
  }
  const filters: TListFilters = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed) filters[key] = trimmed;
    } else if (Array.isArray(raw)) {
      const values = raw
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      if (values.length) filters[key] = values;
    } else {
      throw new BadRequestException(
        `filter ${key} must be a string or string array`,
      );
    }
  }
  return filters;
}
