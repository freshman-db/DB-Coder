import postgres from 'postgres';

const POOL_OPTIONS = {
  idle_timeout: 120,
  max_lifetime: 3600,
  max: 10,
} as const;

let sharedConnectionString: string | null = null;
let sharedSql: postgres.Sql | null = null;
let consumerCount = 0;
let closePromise: Promise<void> | null = null;
let closed = false;

export function getDb(connectionString: string): postgres.Sql {
  if (closed) {
    throw new Error('Cannot acquire DB after shutdown');
  }
  if (closePromise) {
    throw new Error('Cannot acquire DB while shutdown is in progress');
  }

  if (sharedSql) {
    if (sharedConnectionString !== connectionString) {
      throw new Error('Postgres pool already initialized with a different connection string');
    }
    consumerCount += 1;
    return sharedSql;
  }

  sharedConnectionString = connectionString;
  sharedSql = postgres(connectionString, POOL_OPTIONS);
  consumerCount = 1;
  return sharedSql;
}

export async function closeDb(): Promise<void> {
  if (consumerCount === 0) {
    if (closePromise) {
      await closePromise;
    }
    return;
  }

  consumerCount -= 1;
  if (consumerCount > 0) {
    return;
  }

  if (!sharedSql) {
    closed = true;
    return;
  }

  if (!closePromise) {
    const sql = sharedSql;
    closed = true;
    closePromise = (async () => {
      try {
        await sql.end();
      } finally {
        if (sharedSql === sql) {
          sharedSql = null;
          sharedConnectionString = null;
        }
        closePromise = null;
      }
    })();
  }
  await closePromise;
}

export async function resetDbForTesting(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetDbForTesting is only available when NODE_ENV=test');
  }

  const pendingClose = closePromise;
  const sql = sharedSql;

  sharedConnectionString = null;
  sharedSql = null;
  consumerCount = 0;
  closePromise = null;
  closed = false;

  if (pendingClose) {
    await pendingClose.catch(() => undefined);
    return;
  }

  if (sql) {
    await sql.end().catch(() => undefined);
  }
}
