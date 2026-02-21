import type postgres from 'postgres';
import type { Memory, MemoryCategory } from './types.js';
import { closeDb, getDb } from '../db.js';
import { log } from '../utils/logger.js';

const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS memories (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('habit','experience','standard','workflow','framework','failure','simplification')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags JSONB DEFAULT '[]',
  source_project TEXT,
  confidence REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memories_title_trgm ON memories USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_content_trgm ON memories USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING gin (to_tsvector('simple', title || ' ' || content));
`;

export class GlobalMemory {
  private sql: postgres.Sql | null;
  private isClosed = false;

  constructor(connectionString: string) {
    this.sql = getDb(connectionString);
  }

  /** Returns the live SQL connection, or throws if this instance has been closed. */
  private getSql(): postgres.Sql {
    if (this.isClosed || !this.sql) {
      throw new Error('GlobalMemory is closed');
    }
    return this.sql;
  }

  async init(): Promise<void> {
    const sql = this.getSql();
    await sql.unsafe(SCHEMA_SQL);
    // Update CHECK constraint to include 'failure' category (for existing tables)
    await sql.unsafe(`
      DO $$ BEGIN
        ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_category_check;
        ALTER TABLE memories ADD CONSTRAINT memories_category_check
          CHECK (category IN ('habit','experience','standard','workflow','framework','failure','simplification'));
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$;
    `);
    log.info('GlobalMemory initialized');
  }

  async search(query: string, limit = 10): Promise<Memory[]> {
    const sql = this.getSql();
    const rows = await sql<Memory[]>`
      SELECT *, ts_rank(to_tsvector('simple', title || ' ' || content),
        plainto_tsquery('simple', ${query})) * confidence AS relevance
      FROM memories
      WHERE to_tsvector('simple', title || ' ' || content) @@ plainto_tsquery('simple', ${query})
         OR title % ${query} OR content % ${query}
      ORDER BY relevance DESC
      LIMIT ${limit}
    `;
    return rows;
  }

  async add(memory: Omit<Memory, 'id' | 'created_at' | 'updated_at'>): Promise<Memory> {
    const sql = this.getSql();
    const [row] = await sql<Memory[]>`
      INSERT INTO memories (category, title, content, tags, source_project, confidence)
      VALUES (${memory.category}, ${memory.title}, ${memory.content},
              ${sql.json(memory.tags)}, ${memory.source_project}, ${memory.confidence})
      RETURNING *
    `;
    return row;
  }

  async updateConfidence(id: number, delta: number): Promise<void> {
    const sql = this.getSql();
    await sql`
      UPDATE memories
      SET confidence = LEAST(1.0, GREATEST(0.0, confidence + ${delta})),
          updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  async getByCategory(category: MemoryCategory, limit = 20): Promise<Memory[]> {
    const sql = this.getSql();
    return sql<Memory[]>`
      SELECT * FROM memories
      WHERE category = ${category}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ${limit}
    `;
  }

  async getRelevant(query: string, maxTokens = 2000): Promise<string> {
    // No assertOpen() needed — delegates to search() which already guards
    const memories = await this.search(query, 10);
    let result = '';
    let approxTokens = 0;
    for (const m of memories) {
      const entry = `[${m.category}] ${m.title}: ${m.content}\n`;
      const tokens = Math.ceil(entry.length / 4); // rough token estimate
      if (approxTokens + tokens > maxTokens) break;
      result += entry;
      approxTokens += tokens;
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    await closeDb();
    this.sql = null;
  }
}
