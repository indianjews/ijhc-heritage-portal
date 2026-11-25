/**
 * A small in-memory stand-in for the service-role Supabase client, covering
 * only what the backup cron uses: select with count/head, is/lte/gt/eq
 * filters, order (by created_at then id), range, update().eq(), and
 * storage.download.
 *
 * Every range() call is recorded so tests can prove pagination happened.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface FakeAdminState {
  rows: Record<string, Row[]>;
  /** Tables whose head count reports one more row than exists (a short read). */
  short: Set<string>;
  ranges: [string, number, number][];
  updates: { table: string; id: unknown; values: Row }[];
  /** storage path -> bytes; a missing path is a download error. */
  storage: Record<string, Uint8Array>;
  /** Error to return from any select on this table with a filter on backed_up_at. */
  columnMissing?: boolean;
  /** Make the update for this file id fail. */
  failUpdateFor?: Set<unknown>;
  /** Called on each download, e.g. to advance a fake clock. */
  onDownload?: (path: string) => void;
}

export function fakeState(): FakeAdminState {
  return { rows: {}, short: new Set(), ranges: [], updates: [], storage: {}, failUpdateFor: new Set() };
}

export function fakeAdmin(state: FakeAdminState) {
  return {
    from(table: string) {
      return {
        select(_columns: string, options?: { count?: string; head?: boolean }) {
          const filters: Filter[] = [];
          let touchesBackedUp = false;
          const all = () => (state.rows[table] ?? []).filter((row) => filters.every((f) => f(row)));
          const sorted = () => [...all()].sort((a, b) =>
            String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
          const missing = () => state.columnMissing && touchesBackedUp
            ? { code: '42703', message: 'column item_files.backed_up_at does not exist' } : null;
          const query = {
            is(column: string, value: null) {
              if (column === 'backed_up_at') touchesBackedUp = true;
              filters.push((row) => (row[column] ?? null) === value);
              return query;
            },
            lte(column: string, value: number) { filters.push((row) => Number(row[column]) <= value); return query; },
            gt(column: string, value: number) { filters.push((row) => Number(row[column]) > value); return query; },
            order() { return query; },
            async range(from: number, to: number) {
              state.ranges.push([table, from, to]);
              const error = missing();
              if (error) return { data: null, error };
              return { data: sorted().slice(from, to + 1), error: null };
            },
            then(resolve: (value: unknown) => void, reject?: (reason: unknown) => void) {
              // Awaited directly: only the head/count form is used that way.
              const error = missing();
              const extra = !filters.length && state.short.has(table) ? 1 : 0;
              return Promise.resolve(error ? { count: null, error } : { count: all().length + extra, error: null })
                .then(resolve, reject);
            },
          };
          void options;
          return query;
        },
        update(values: Row) {
          return {
            async eq(column: string, value: unknown) {
              if (state.failUpdateFor?.has(value)) return { error: { message: 'update refused' } };
              state.updates.push({ table, id: value, values });
              for (const row of state.rows[table] ?? []) if (row[column] === value) Object.assign(row, values);
              return { error: null };
            },
          };
        },
      };
    },
    storage: {
      from: () => ({
        async download(path: string) {
          state.onDownload?.(path);
          const bytes = state.storage[path];
          if (!bytes) return { data: null, error: { message: `object not found: ${path}` } };
          return { data: new Blob([bytes as BlobPart]), error: null };
        },
      }),
    },
  };
}
