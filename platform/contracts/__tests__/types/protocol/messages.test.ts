import { describe, expect, it } from 'vitest';
import {
  EMessageSeverity,
  type IUserMessage,
  isMessageContent,
  isMessageSeverity,
  isMessageStatus,
} from '../../../src/types/protocol/messages.js';

describe('platform message protocol', () => {
  it('defines stable severity and inbox status values', () => {
    expect(Object.values(EMessageSeverity)).toEqual([
      'info',
      'success',
      'warning',
      'critical',
    ]);
    expect(isMessageSeverity('warning')).toBe(true);
    expect(isMessageSeverity('urgent')).toBe(false);
    expect(isMessageStatus('all')).toBe(true);
    expect(isMessageStatus('pending')).toBe(false);
  });

  it('validates the neutral plain message shape', () => {
    expect(
      isMessageContent({
        version: 1,
        kind: 'plain',
        title: { kind: 'literal', text: 'Maintenance' },
        body: {
          kind: 'i18n',
          key: 'messages.maintenance',
          values: { minutes: 15 },
          fallback: 'Maintenance in 15 minutes',
        },
        action: { label: 'Open', href: '/messages/maintenance' },
      }),
    ).toBe(true);
    expect(
      isMessageContent({
        version: 1,
        kind: 'plain',
        title: { kind: 'literal', text: 'Unsafe link' },
        body: { kind: 'literal', text: 'Open' },
        action: { label: 'Open', href: 'https://example.com' },
      }),
    ).toBe(false);
    expect(
      isMessageContent({
        version: 1,
        kind: 'unknown-extension',
        title: { kind: 'literal', text: 'Extension' },
        body: { kind: 'literal', text: 'Unsupported' },
      }),
    ).toBe(false);
  });

  it('keeps the generic message projection free of reward state', () => {
    const message: IUserMessage = {
      id: 'message-1',
      content: {
        version: 1,
        kind: 'plain',
        title: { kind: 'literal', text: 'Hello' },
        body: { kind: 'literal', text: 'World' },
      },
      severity: EMessageSeverity.INFO,
      createdByUserId: null,
      recipientUserId: 'user-1',
      createdAt: '2026-06-18T10:00:00.000Z',
      canMarkRead: true,
      resolutionStatus: 'not-required',
      readAt: null,
    };
    expect(message.content.kind).toBe('plain');
  });
});
