import { beforeEach, describe, expect, it } from 'vitest';
import {
  isCurrentAuthSession,
  isSameAuthSession,
  useAuthStore,
} from '@/stores/authStore.js';

describe('useAuthStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
  });

  it('logs in with token and user', () => {
    useAuthStore
      .getState()
      .login('jwt-token', { id: 'u1', name: 'Ada', email: 'ada@example.com' });

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().token).toBe('jwt-token');
    expect(useAuthStore.getState().user?.name).toBe('Ada');
  });

  it('preserves the server role on login', () => {
    useAuthStore.getState().login('jwt-token', {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
    });

    expect(useAuthStore.getState().user?.role).toBe('guest');
  });

  it('keeps the access token and session data in memory only', () => {
    useAuthStore.getState().login('jwt-token', {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      preferences: {
        language: 'zh-CN',
        emailTurnRemindersEnabled: true,
      },
    });

    expect(localStorage.getItem('seti-auth')).toBeNull();
  });

  it('logs out and clears auth fields', () => {
    useAuthStore
      .getState()
      .login('jwt-token', { id: 'u1', name: 'Ada', email: 'ada@example.com' });
    useAuthStore.getState().logout();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('keeps the account session across token refresh but not a new login', () => {
    const user = { id: 'u1', name: 'Ada', email: 'ada@example.com' };
    useAuthStore.getState().login('first-token', user);
    const original = useAuthStore.getState();

    useAuthStore.getState().refreshSession('rotated-token', user, original);
    expect(isCurrentAuthSession(original)).toBe(true);
    expect(isSameAuthSession(original)).toBe(false);

    useAuthStore.getState().login('new-login-token', user);
    expect(isCurrentAuthSession(original)).toBe(false);
    useAuthStore.getState().refreshSession('late-token', user, original);
    expect(useAuthStore.getState().token).toBe('new-login-token');
  });

  it('does not treat a logged-out anonymous session as the same restore session', () => {
    const initial = useAuthStore.getState();
    useAuthStore.getState().logout();
    expect(isSameAuthSession(initial)).toBe(false);
  });

  it('keeps a newer permission result when an older refresh response arrives', () => {
    const guest = {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'guest',
    };
    useAuthStore.getState().login('first-token', guest);
    const pendingRefresh = useAuthStore.getState();
    const player = { ...guest, role: 'player' };
    useAuthStore.getState().setUser(player);

    useAuthStore
      .getState()
      .refreshSession('rotated-token', guest, pendingRefresh);

    expect(useAuthStore.getState().token).toBe('rotated-token');
    expect(useAuthStore.getState().user).toEqual(player);
    expect(isCurrentAuthSession(pendingRefresh)).toBe(true);
  });

  it('rejects a refresh response for a different authenticated account', () => {
    const firstUser = { id: 'u1', name: 'Ada', email: 'ada@example.com' };
    const secondUser = { id: 'u2', name: 'Bea', email: 'bea@example.com' };
    useAuthStore.getState().login('first-token', firstUser);
    const requestSession = useAuthStore.getState();

    useAuthStore
      .getState()
      .refreshSession('second-token', secondUser, requestSession);

    expect(useAuthStore.getState().token).toBe('first-token');
    expect(useAuthStore.getState().user?.id).toBe(firstUser.id);
  });
});
