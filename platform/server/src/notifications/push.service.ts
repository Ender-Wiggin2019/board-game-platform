import type { IAccountPreferences } from '@board-platform/contracts/types/protocol/accountPreferences';
import type { IBrowserNotificationPayload } from '@board-platform/contracts/types/protocol/notifications';
import { normalizeUserLanguage } from '@board-platform/contracts/types/protocol/userLanguage';
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import webpush from 'web-push';
import {
  getRuntimeConfig,
  type RuntimeConfig,
} from '@/config/runtimeConfig.js';
import { DRIZZLE_DB } from '@/persistence/drizzle.module.js';
import { AccountPreferencesRepository } from '@/persistence/repository/AccountPreferencesRepository.js';
import {
  type IPushSubscriptionInput,
  PushSubscriptionRepository,
  type TPushSubscriptionSaveMode,
} from '@/persistence/repository/PushSubscriptionRepository.js';
import { isAllowedPushEndpoint } from './push-endpoint.js';

/**
 * Web Push delivery.
 *
 * Configured from the validated runtime config; when VAPID values are absent
 * external Web Push is unavailable, while online delivery through a connected
 * browser tab can still work.
 *
 * Endpoints belong to whichever push service the browser chose (Apple for iOS
 * Home Screen web apps, FCM for Chrome, Mozilla for Firefox). The endpoint URL
 * carries that routing, so nothing here is vendor-specific.
 */

/** Payload delivered to an online tab or the service worker's `push` handler. */
export type IPushPayload = IBrowserNotificationPayload;

export type TPushPayloadInput =
  | IPushPayload
  | ((
      preferences: Readonly<IAccountPreferences>,
    ) => IPushPayload | Promise<IPushPayload>);

/**
 * Deliver through a connected browser tab before falling back to Web Push.
 * Returning true means the tab either displayed or intentionally suppressed
 * the notification, so no second delivery should be attempted.
 */
export type TOnlineDelivery = (
  userId: string,
  payload: IPushPayload,
) => Promise<boolean>;

export interface INativeSessionPushInput {
  readonly sessionId: string;
  readonly sessionName?: string | null;
  readonly url: string;
  readonly kind: 'start' | 'turn' | 'end' | 'control';
}

/** Push services return these when a subscription is permanently gone. */
const GONE_STATUS_CODES = new Set([404, 410]);
const DELIVERY_TIMEOUT_MS = 10_000;

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly subscriptions: PushSubscriptionRepository;
  private readonly preferences: AccountPreferencesRepository;
  private readonly vapid: RuntimeConfig['vapid'];
  private readonly configured: boolean;
  private onlineDelivery: TOnlineDelivery | undefined;
  private readonly onlineDeliveries = new Set<TOnlineDelivery>();

  public constructor(@Inject(DRIZZLE_DB) db: NodePgDatabase) {
    this.subscriptions = new PushSubscriptionRepository(db);
    this.preferences = new AccountPreferencesRepository(db);

    this.vapid = getRuntimeConfig().vapid;
    this.configured = this.vapid !== undefined;
    if (this.vapid) {
      webpush.setVapidDetails(
        this.vapid.subject,
        this.vapid.publicKey,
        this.vapid.privateKey,
      );
    } else {
      this.logger.warn(
        'VAPID keys absent (SETI_VAPID_PUBLIC_KEY / SETI_VAPID_PRIVATE_KEY); external Web Push is disabled, online delivery remains available',
      );
    }
  }

  public isConfigured(): boolean {
    return (
      this.configured ||
      this.onlineDelivery !== undefined ||
      this.onlineDeliveries.size > 0
    );
  }

  public getPublicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  public setOnlineDelivery(delivery: TOnlineDelivery | undefined): void {
    this.onlineDelivery = delivery;
  }

  /** Adds an independent online transport without replacing a game adapter. */
  public addOnlineDelivery(delivery: TOnlineDelivery): () => void {
    this.onlineDeliveries.add(delivery);
    return () => this.onlineDeliveries.delete(delivery);
  }

  public async enableForUser(userId: string): Promise<void> {
    await this.subscriptions.enableForUser(userId);
  }

  public async saveSubscription(
    userId: string,
    input: IPushSubscriptionInput,
    mode: TPushSubscriptionSaveMode,
  ): Promise<void> {
    const result = await this.subscriptions.save(userId, input, mode);
    if (result === 'conflict') {
      throw new ConflictException(
        'Push subscription belongs to another account; rotate it and retry',
      );
    }
  }

  public async removeSubscription(
    userId: string,
    endpoint: string,
  ): Promise<void> {
    await this.subscriptions.deleteByEndpoint(userId, endpoint);
  }

  public async removeAllForUser(userId: string): Promise<void> {
    await this.subscriptions.deleteForUser(userId);
  }

  public async countForUser(userId: string): Promise<number> {
    return (await this.subscriptions.listForUser(userId)).length;
  }

  /**
   * Deliver to every device registered for `userId`.
   *
   * Returns the number of successful deliveries. Failures never throw: this is
   * called from gameplay paths where a push service outage must not interrupt a
   * turn.
   */
  public async sendToUser(
    userId: string,
    payload: TPushPayloadInput,
  ): Promise<number> {
    if (!this.isConfigured()) return 0;

    const preferences = await this.preferences.get(userId);
    if (preferences.pushNotificationsEnabled !== true) return 0;

    const resolvedPayload =
      typeof payload === 'function' ? await payload(preferences) : payload;
    const onlineDeliveries = [
      ...(this.onlineDelivery ? [this.onlineDelivery] : []),
      ...this.onlineDeliveries,
    ];
    for (const onlineDelivery of onlineDeliveries) {
      try {
        if (await onlineDelivery(userId, resolvedPayload)) return 1;
      } catch (error) {
        this.logger.warn(
          `online notification delivery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (!this.vapid) return 0;

    const targets = await this.subscriptions.listForUser(userId);
    if (targets.length === 0) return 0;

    const body = JSON.stringify(resolvedPayload);
    const delivered: string[] = [];
    const gone: string[] = [];
    const invalid: string[] = [];

    await Promise.all(
      targets.map(async (target) => {
        if (!isAllowedPushEndpoint(target.endpoint)) {
          invalid.push(target.endpoint);
          return;
        }
        try {
          await webpush.sendNotification(
            {
              endpoint: target.endpoint,
              keys: { p256dh: target.p256dh, auth: target.auth },
            },
            body,
            {
              // Turn alerts are time-sensitive: without high urgency Android's
              // Doze can hold them for a long time. TTL caps how long the push
              // service keeps trying, so a stale "your turn" is dropped rather
              // than delivered hours later.
              urgency: 'high',
              TTL: 60 * 60 * 12,
              timeout: DELIVERY_TIMEOUT_MS,
            },
          );
          delivered.push(target.endpoint);
        } catch (error) {
          const statusCode = (error as { statusCode?: number }).statusCode;
          if (statusCode !== undefined && GONE_STATUS_CODES.has(statusCode)) {
            // The device unsubscribed or the app was deleted. iOS invalidates
            // subscriptions readily, so pruning here is what stops dead
            // endpoints accumulating.
            gone.push(target.endpoint);
            return;
          }
          this.logger.warn(
            `push delivery failed (status ${statusCode ?? 'unknown'}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );

    const discarded = [...gone, ...invalid];
    if (discarded.length > 0) {
      await this.subscriptions.deleteEndpoints(userId, discarded);
    }
    if (gone.length > 0) {
      this.logger.log(`pruned ${gone.length} expired push subscription(s)`);
    }
    if (invalid.length > 0) {
      this.logger.warn(
        `pruned ${invalid.length} push subscription(s) with unsupported endpoints`,
      );
    }
    if (delivered.length > 0) {
      await this.subscriptions.markNotified(userId, delivered, new Date());
    }
    return delivered.length;
  }

  /** Native-session equivalent of the legacy game notification helpers. */
  public async sendToSession(
    userId: string,
    input: INativeSessionPushInput,
  ): Promise<number> {
    return this.sendToUser(userId, (preferences) => {
      const language = normalizeUserLanguage(preferences.language);
      const name = input.sessionName?.trim();
      const quoted = name ? ` “${name.slice(0, 50)}”` : '';
      const copy =
        input.kind === 'turn'
          ? language === 'en'
            ? { title: 'Your turn', body: `It’s your turn${quoted}.` }
            : {
                title: '轮到你行动了',
                body: `你的对局${name ? `「${name.slice(0, 50)}」` : ''}轮到你行动了。`,
              }
          : input.kind === 'start'
            ? language === 'en'
              ? {
                  title: 'Game started',
                  body: `Your game${quoted} has started.`,
                }
              : {
                  title: '对局开始',
                  body: `你的对局${name ? `「${name.slice(0, 50)}」` : ''}已经开始。`,
                }
            : input.kind === 'end'
              ? language === 'en'
                ? { title: 'Game over', body: `Your game${quoted} has ended.` }
                : {
                    title: '对局结束',
                    body: `你的对局${name ? `「${name.slice(0, 50)}」` : ''}已经结束。`,
                  }
              : language === 'en'
                ? {
                    title: 'Game update',
                    body: `Your game${quoted} was updated.`,
                  }
                : {
                    title: '对局更新',
                    body: `你的对局${name ? `「${name.slice(0, 50)}」` : ''}已更新。`,
                  };
      return {
        ...copy,
        url: input.url,
        tag: `${input.kind}:session:${input.sessionId}`,
      };
    });
  }
}
