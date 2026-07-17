import type Database from 'better-sqlite3';

import type { AnyRecord } from '@/shared/types.js';
import { readJsonRecord, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type OpenCodeTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const readTokenNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const readMessageTokenTotals = (data: unknown): OpenCodeTokenTotals | null => {
  const info = readJsonRecord(data);
  if (readOptionalString(info?.role) !== 'assistant') {
    return null;
  }

  const tokens = readObjectRecord(info?.tokens);
  if (!tokens) {
    return null;
  }

  const cache = readObjectRecord(tokens.cache);
  return {
    inputTokens: readTokenNumber(tokens.input),
    outputTokens: readTokenNumber(tokens.output),
    reasoningTokens: readTokenNumber(tokens.reasoning),
    cacheReadTokens: readTokenNumber(cache?.read),
    cacheWriteTokens: readTokenNumber(cache?.write),
  };
};

const sumTokenTotals = (totals: OpenCodeTokenTotals): number => (
  totals.inputTokens
  + totals.outputTokens
  + totals.reasoningTokens
  + totals.cacheReadTokens
  + totals.cacheWriteTokens
);

const readLatestContextUsed = (db: Database.Database, sessionId: string): number => {
  const rows = db.prepare(`
    SELECT data
    FROM message
    WHERE session_id = ?
    ORDER BY time_created DESC, id DESC
  `).all(sessionId) as { data: string }[];

  for (const row of rows) {
    const totals = readMessageTokenTotals(row.data);
    if (totals) {
      const used = sumTokenTotals(totals);
      if (used > 0) {
        return used;
      }
    }
  }

  return 0;
};

const readSessionTokenTotals = (
  db: Database.Database,
  sessionId: string,
): OpenCodeTokenTotals | null => {
  const columns = db.prepare('PRAGMA table_info(session)').all() as { name: string }[];
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
  if (!requiredColumns.every((column) => columnNames.has(column))) {
    return null;
  }

  const row = db.prepare(`
    SELECT
      tokens_input AS inputTokens,
      tokens_output AS outputTokens,
      tokens_reasoning AS reasoningTokens,
      tokens_cache_read AS cacheReadTokens,
      tokens_cache_write AS cacheWriteTokens
    FROM session
    WHERE id = ?
  `).get(sessionId) as Partial<OpenCodeTokenTotals> | undefined;

  if (!row) {
    return null;
  }

  return {
    inputTokens: readTokenNumber(row.inputTokens),
    outputTokens: readTokenNumber(row.outputTokens),
    reasoningTokens: readTokenNumber(row.reasoningTokens),
    cacheReadTokens: readTokenNumber(row.cacheReadTokens),
    cacheWriteTokens: readTokenNumber(row.cacheWriteTokens),
  };
};

const aggregateMessageTokenTotals = (
  db: Database.Database,
  sessionId: string,
): OpenCodeTokenTotals => {
  const totals: OpenCodeTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const rows = db.prepare('SELECT data FROM message WHERE session_id = ?').all(sessionId) as { data: string }[];

  for (const row of rows) {
    const messageTotals = readMessageTokenTotals(row.data);
    if (!messageTotals) {
      continue;
    }

    totals.inputTokens += messageTotals.inputTokens;
    totals.outputTokens += messageTotals.outputTokens;
    totals.reasoningTokens += messageTotals.reasoningTokens;
    totals.cacheReadTokens += messageTotals.cacheReadTokens;
    totals.cacheWriteTokens += messageTotals.cacheWriteTokens;
  }

  return totals;
};

export const readOpenCodeTokenUsage = (
  db: Database.Database,
  sessionId: string,
): AnyRecord | undefined => {
  const sessionExists = Boolean(db.prepare('SELECT 1 FROM session WHERE id = ? LIMIT 1').get(sessionId));
  if (!sessionExists) {
    return undefined;
  }

  const sessionTotals = readSessionTokenTotals(db, sessionId);
  const totals = sessionTotals && sumTokenTotals(sessionTotals) > 0
    ? sessionTotals
    : aggregateMessageTokenTotals(db, sessionId);
  const used = sumTokenTotals(totals);
  const contextUsed = readLatestContextUsed(db, sessionId);

  const inputTokens = totals.inputTokens + totals.cacheReadTokens;
  return {
    used,
    contextUsed,
    inputTokens,
    outputTokens: totals.outputTokens,
    breakdown: {
      input: inputTokens,
      output: totals.outputTokens,
    },
  };
};
