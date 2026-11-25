import 'server-only';

/**
 * Which deployment runs the nightly jobs.
 *
 * Production is the Center's own Vercel project, `ijhc-heritage-portal` in the
 * `indianjews` team, served at https://archive.indianjews.org. That project is
 * the cron home and is the one that sets CRON_HOME=1.
 *
 * The gate stays because vercel.json registers the crons for every deployment
 * of this repository — previews, a staging copy, or the legacy personal
 * deployment (heritage-portal-snowy.vercel.app, now deprecated) if it is still
 * running against the same database. Without the gate every job would run once
 * per deployment: two backups, two translation sweeps, and a reading retry
 * spent on whichever project's Gemini key happens to be blocked.
 *
 * Only the project with CRON_HOME=1 runs them. Everywhere else the scheduler is
 * answered 200 with `skipped`, so the platform does not report a failure.
 */
export function isCronHome(): boolean {
  return process.env.CRON_HOME === '1';
}
