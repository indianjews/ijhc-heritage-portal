import 'server-only';
import { readFeedbackRecipients } from '@/lib/items/queries';
import type { Item } from '@/lib/types';
import type { CorrectionChanges, FeedbackKind, ReportReason } from '@/lib/items/public-input';
import { siteUrl } from '@/lib/site';
import { sendMail } from './index';
import { recordFeedbackMail } from './templates';

export async function notifyRecordFeedback(item: Item, kind: FeedbackKind, body: string,
  changes: CorrectionChanges | undefined, correctionId: string, token?: string, reason?: ReportReason) {
  // A private report goes to the experts only — never to the person who
  // uploaded the record, who may be the very subject of the report.
  const recipients = (await readFeedbackRecipients(item)).filter((r) => kind !== 'report' || !r.uploader);
  for (const recipient of recipients) {
    await sendMail(recordFeedbackMail({
      to: recipient.email, language: recipient.language, title: item.title, kind, body, changes, reason,
      publicUrl: `${siteUrl()}/portal/${item.id}`,
      reviewUrl: kind === 'report' ? `${siteUrl()}/review/corrections` : undefined,
      objectionUrl: recipient.uploader && token
        ? `${siteUrl()}/corrections/${correctionId}/objection?t=${encodeURIComponent(token)}` : undefined,
    }));
  }
}
