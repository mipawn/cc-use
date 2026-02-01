import { getDatabase } from "../config/database";

export interface UsageLogEntry {
  providerId: string;
  timestamp: string;
  remaining: number;
  used: number;
  unit: string;
}

export interface UsageLog {
  entries: UsageLogEntry[];
}

export function recordUsage(
  providerId: string,
  remaining: number,
  used: number,
  unit: string
): void {
  const db = getDatabase();

  // 插入新记录
  db.prepare(`
    INSERT INTO usage_logs (provider_id, timestamp, remaining, used, unit)
    VALUES (?, ?, ?, ?, ?)
  `).run(providerId, new Date().toISOString(), remaining, used, unit);

  // 清理 30 天前的数据
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  db.prepare("DELETE FROM usage_logs WHERE timestamp < ?").run(thirtyDaysAgo.toISOString());
}

export function getTodayUsage(providerId: string): number | undefined {
  const db = getDatabase();

  // Get today's start (00:00:00)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();

  // 获取该 provider 的所有记录，按时间排序
  const rows = db.prepare(`
    SELECT timestamp, used FROM usage_logs
    WHERE provider_id = ?
    ORDER BY timestamp ASC
  `).all(providerId) as { timestamp: string; used: number }[];

  if (rows.length === 0) {
    return undefined;
  }

  // Find entries for today and before today
  const todayEntries = rows.filter(row => row.timestamp >= todayStr);
  const beforeTodayEntries = rows.filter(row => row.timestamp < todayStr);

  // Get baseline (last entry before today, or first entry of today)
  let baselineUsed: number;
  if (beforeTodayEntries.length > 0) {
    baselineUsed = beforeTodayEntries[beforeTodayEntries.length - 1].used;
  } else if (todayEntries.length > 0) {
    baselineUsed = todayEntries[0].used;
  } else {
    return undefined;
  }

  // Get current used (latest entry)
  const latestEntry = rows[rows.length - 1];
  const currentUsed = latestEntry.used;

  // Today's usage = current used - baseline used
  return Math.max(0, currentUsed - baselineUsed);
}

export function getUsageHistory(
  providerId: string,
  days: number = 7
): { date: string; used: number }[] {
  const db = getDatabase();

  // 获取该 provider 的所有记录，按时间排序
  const rows = db.prepare(`
    SELECT timestamp, used FROM usage_logs
    WHERE provider_id = ?
    ORDER BY timestamp ASC
  `).all(providerId) as { timestamp: string; used: number }[];

  if (rows.length === 0) {
    return [];
  }

  // Group by date and calculate daily usage
  const dailyUsage: Map<string, { firstUsed: number; lastUsed: number }> = new Map();

  for (const row of rows) {
    const date = row.timestamp.split("T")[0];
    const existing = dailyUsage.get(date);

    if (!existing) {
      dailyUsage.set(date, { firstUsed: row.used, lastUsed: row.used });
    } else {
      existing.lastUsed = row.used;
    }
  }

  // Calculate daily usage
  const result: { date: string; used: number }[] = [];
  const dates = Array.from(dailyUsage.keys()).sort();

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const data = dailyUsage.get(date)!;

    // Daily usage = last used of day - first used of day (or previous day's last)
    let dailyUsedAmount: number;
    if (i === 0) {
      dailyUsedAmount = data.lastUsed - data.firstUsed;
    } else {
      const prevDate = dates[i - 1];
      const prevData = dailyUsage.get(prevDate)!;
      dailyUsedAmount = data.lastUsed - prevData.lastUsed;
    }

    result.push({ date, used: Math.max(0, dailyUsedAmount) });
  }

  // Return only last N days
  return result.slice(-days);
}
