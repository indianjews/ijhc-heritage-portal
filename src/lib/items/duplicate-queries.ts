import 'server-only';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { duplicateHint, type ChecksumMatch, type DuplicateHint } from '@/lib/files/duplicate-hint';

/**
 * Is a file with this SHA-256 already in the archive? For the contributor's
 * upload screen, which has no account, so the lookup runs with the service
 * role — and returns only what `duplicateHint` allows: a published record's
 * id at most, never anything about an unpublished one.
 */
export async function findDuplicateHint(checksum: string): Promise<DuplicateHint> {
  if (!/^[a-f0-9]{64}$/.test(checksum)) return null;
  const { data, error } = await createAdminSupabase()
    .from('item_files')
    .select('item_id, items!inner(status, access, category, deleted_at)')
    .eq('checksum', checksum)
    .order('created_at', { ascending: true })
    .range(0, 19);
  if (error) throw error;
  return duplicateHint((data ?? []) as unknown as ChecksumMatch[]);
}

export async function readDuplicates(itemId: string) {
  const db = await createServerSupabase();
  const { data, error } = await db.from('item_duplicates')
    .select('id, item_id, other_item_id, reason').is('resolved_at', null)
    .or(`item_id.eq.${itemId},other_item_id.eq.${itemId}`);
  if (error) throw error;
  const pairs = data ?? [];
  if (!pairs.length) return [];
  const ids = pairs.map((p) => p.item_id === itemId ? p.other_item_id : p.item_id);
  const { data: items, error: itemError } = await db.from('items')
    .select('id,title,created_at,item_files(id,mime_type,is_primary)')
    .in('id', ids).is('deleted_at', null);
  if (itemError) throw itemError;
  return pairs.flatMap((pair) => {
    const item = items?.find((i) => i.id === (pair.item_id === itemId ? pair.other_item_id : pair.item_id));
    if (!item) return [];
    const cover = item.item_files.find((f) => f.is_primary && f.mime_type.startsWith('image/'));
    return [{ id: pair.id as string, reason: pair.reason as string, item: { id: item.id as string, title: item.title as string, thumbnail: cover ? `/api/files/${cover.id}?thumb` : null } }];
  });
}
