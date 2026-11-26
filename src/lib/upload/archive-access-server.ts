import 'server-only';
import { createServerSupabase, getCurrentProfile } from '@/lib/supabase/server';
import type { Profile } from '@/lib/types';
import { archiveUploadAccess, israelToday, type ArchiveAccess } from './archive-access';

/**
 * The signed-in person, if they may use /archive-upload right now.
 *
 * Asks the database (can_archive_upload(), migration 0043) — the one place
 * the rule is enforced — and only uses the role-and-dates mirror to say which
 * kind of access it is. If the function is missing (migration not applied),
 * experts keep their access and nobody else gets any.
 */
export async function getArchiveUploader(): Promise<{ profile: Profile; access: Exclude<ArchiveAccess, null> } | null> {
  const profile = await getCurrentProfile();
  if (!profile) return null;
  const local = archiveUploadAccess(profile, israelToday());
  const { data, error } = await (await createServerSupabase()).rpc('can_archive_upload');
  if (error) return local === 'expert' ? { profile, access: 'expert' } : null;
  if (data !== true) return null;
  return { profile, access: local === 'expert' ? 'expert' : 'window' };
}
