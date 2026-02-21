import postgres from 'postgres';

const POOL_OPTIONS = {
  idle_timeout: 120,
  max_lifetime: 3600,
  max: 10,
} as const;

let sharedConnectionString: string | null = null;
let sharedSql: postgres.Sql | null = null;
let closePromise: Promise<void> | null = null;

export function getDb(connectionString: string): postgres.Sql {
  if (sharedSql) {
    if (sharedConnectionString !== connectionString) {
      throw new Error('Postgres pool already initialized with a different connection string');
    }
    return sharedSql;
  }

  sharedConnectionString = connectionString;
  sharedSql = postgres(connectionString, POOL_OPTIONS);
  return sharedSql;
}

export async function closeDb(): Promise<void> {
  if (!sharedSql) return;
  if (!closePromise) {
    const sql = sharedSql;
    closePromise = sql.end().then(() => {
      if (sharedSql === sql) {
        sharedSql = null;
        sharedConnectionString = null;
      }
      closePromise = null;
    });
  }
  await closePromise;
}
