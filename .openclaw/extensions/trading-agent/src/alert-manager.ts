/**
 * Alert Manager — deduplicates watchdog alerts to prevent Telegram flooding.
 *
 * Severity levels:
 *   INFO     — console.log only, no Telegram
 *   WARN     — max 1x per DEDUP_WINDOW (60min), duplicates counted
 *   CRITICAL — every occurrence sent to Telegram
 *
 * State is in-memory only, resets on restart.
 */

export type Severity = "INFO" | "WARN" | "CRITICAL";

interface AlertState {
  key: string;
  severity: Severity;
  lastSentAt: number;      // epoch ms of last Telegram send
  suppressedCount: number;  // how many times suppressed since last send
  active: boolean;          // currently in alert state
  lastMessage: string;
}

const DEDUP_WINDOW = 60 * 60 * 1000; // 60 minutes

type TelegramSender = (text: string) => Promise<void>;

export class AlertManager {
  private state = new Map<string, AlertState>();
  private sendTelegram: TelegramSender;

  constructor(sendTelegram: TelegramSender) {
    this.sendTelegram = sendTelegram;
  }

  /**
   * Send an alert. Returns true if a Telegram message was sent.
   */
  async sendAlert(key: string, severity: Severity, message: string): Promise<boolean> {
    const now = Date.now();
    let entry = this.state.get(key);

    if (!entry) {
      entry = { key, severity, lastSentAt: 0, suppressedCount: 0, active: false, lastMessage: "" };
      this.state.set(key, entry);
    }

    entry.active = true;
    entry.severity = severity;
    entry.lastMessage = message;

    // INFO — log only
    if (severity === "INFO") {
      console.log(`[alert] INFO ${key}: ${message}`);
      return false;
    }

    // CRITICAL — always send
    if (severity === "CRITICAL") {
      const suffix = entry.suppressedCount > 0
        ? `\n_(${entry.suppressedCount}x unterdrückt seit letztem Alert)_`
        : "";
      console.log(`[alert] CRITICAL ${key}: ${message}`);
      await this.sendTelegram(message + suffix);
      entry.lastSentAt = now;
      entry.suppressedCount = 0;
      return true;
    }

    // WARN — dedup within window
    const elapsed = now - entry.lastSentAt;
    if (elapsed < DEDUP_WINDOW) {
      entry.suppressedCount++;
      console.log(`[alert] WARN ${key}: suppressed (${entry.suppressedCount}x in last ${Math.round(elapsed / 60_000)}min)`);
      return false;
    }

    // Window expired — send with suppression count
    const suffix = entry.suppressedCount > 0
      ? `\n_(${entry.suppressedCount}x in der letzten Stunde)_`
      : "";
    console.log(`[alert] WARN ${key}: ${message}`);
    await this.sendTelegram(message + suffix);
    entry.lastSentAt = now;
    entry.suppressedCount = 0;
    return true;
  }

  /**
   * Mark an alert as resolved. Sends a recovery message if it was previously active.
   */
  async resolve(key: string): Promise<void> {
    const entry = this.state.get(key);
    if (!entry || !entry.active) return;

    entry.active = false;
    const suppressed = entry.suppressedCount;
    entry.suppressedCount = 0;

    // Only send recovery for WARN/CRITICAL that actually sent a Telegram message
    if (entry.lastSentAt > 0 && entry.severity !== "INFO") {
      const suffix = suppressed > 0 ? ` (${suppressed}x unterdrückt)` : "";
      const msg = `✅ *Alert behoben:* ${key}${suffix}`;
      console.log(`[alert] RESOLVED ${key}`);
      await this.sendTelegram(msg);
    }
  }

  /**
   * Check if an alert key is currently active.
   */
  isActive(key: string): boolean {
    return this.state.get(key)?.active ?? false;
  }
}
