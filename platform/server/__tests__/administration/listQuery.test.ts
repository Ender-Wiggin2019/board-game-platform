import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parsePlatformListQuery } from '@/shared/listQuery.js';

describe('parsePlatformListQuery', () => {
  it('parses bounded filters and clamps page size', () => {
    expect(
      parsePlatformListQuery({
        pageSize: '1000',
        pageNum: '2',
        sort: 'createdAt:desc',
        filters: JSON.stringify({ search: ' ada ', role: ['admin'] }),
      }),
    ).toEqual({
      pageSize: 200,
      pageNum: 2,
      sort: 'createdAt:desc',
      filters: { search: 'ada', role: ['admin'] },
    });
  });

  it('rejects malformed filters and unsafe pagination', () => {
    expect(() => parsePlatformListQuery({ filters: '{' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      parsePlatformListQuery({ pageNum: String(Number.MAX_SAFE_INTEGER) }),
    ).toThrow(BadRequestException);
  });
});
