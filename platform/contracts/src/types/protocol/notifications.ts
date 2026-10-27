/** Payload shared by online notification delivery and Web Push adapters. */
export interface IBrowserNotificationPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}
