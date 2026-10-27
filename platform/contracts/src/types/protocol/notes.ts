/** Hard cap for a single game note; the server rejects longer payloads. */
export const GAME_NOTE_MAX_LENGTH = 20_000;

/** A player's private, per-game note (synced across devices). */
export interface IGameNoteResponse {
  content: string;
  /** ISO timestamp of the last save; null when no note exists yet. */
  updatedAt: string | null;
}

export interface ISaveGameNoteRequest {
  content: string;
}
