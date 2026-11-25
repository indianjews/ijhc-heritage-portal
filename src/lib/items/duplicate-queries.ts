import 'server-only';
import { createServerSupabase } from '@/lib/supabase/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { earlierUploadHint, type ChecksumMatch, type DuplicateHint } from '@/lib/files/duplicate-hint';

/**
 * Has this signed-in user already uploaded a file with these bytes? Only
 * their own records are searched (`items.uploaded_by`); nobody else's upload
 * is ever reported (see src/lib/files/duplicate-hint.ts). Without an uploader
 * id there is no query at all.
 */
export async function findOwnDuplicate(checksum: string, uploaderId: string | null | undefined): Promise<DuplicateHint> {
  if (!uploaderId || !/^[a-f0-9]{64}$/.test(checksum)) return null;
  const { data, error } = await createAdminSupabase()
    .from('item_files')
    .select('item_id, items!inner(uploaded_by, status, access, category, deleted_at)')
    .eq('checksum', checksum)
    .eq('items.uploaded_by', uploaderId)
    .is('items.deleted_at', null)
    .order('created_at', { ascending: true })
    .range(0, 19);
  if (error) throw error;
  return earlierUploadHint((data ?? []) as unknown as ChecksumMatch[], uploaderId);
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
