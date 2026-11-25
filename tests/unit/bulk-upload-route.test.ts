import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * POST /api/items/bulk-upload-item: who may call it, and what it forces
 * regardless of what the browser sent. createItem and the session are mocked;
 * the grant check is real.
 */

const mocks = vi.hoisted(() => ({
  /** The signed-in user and their profile row, as Supabase would return them. */
  session: null as null | { user: { id: string }; profile: { id: string; role: string; email: string } | null },
  createItem: vi.fn(),
}));
// The real getCurrentVolunteer runs; only the session client under it is faked.
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: mocks.session?.user ?? null }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.session?.profile ?? null, error: null }) }) }) }),
  }),
}));
vi.mock('@/lib/items/mutations', () => ({ createItem: mocks.createItem }));
vi.mock('@/lib/i18n', () => ({ getMessages: async () => ({ t: (key: string) => key, language: { code: 'he' } }) }));
vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key-for-grants');

const { issueGrant } = await import('@/lib/files/grant');
const { POST } = await import('@/app/api/items/bulk-upload-item/route');

const signedIn = (role: string) => {
  mocks.session = { user: { id: 'expert-1' }, profile: { id: 'expert-1', role, email: 'e@example.org' } };
};

function granted(path: string, mimeType = 'image/jpeg', fileName = 'flyer.jpg') {
  return { path, ...issueGrant(path), fileName, mimeType, byteSize: 1234 };
}

function body(over: Record<string, unknown> = {}) {
  return {
    description: 'Purim party, Mumbai\nThe Ezra family',
    period: '1952', periodUnknown: false, creditRequired: true, collectorName: 'Levi family',
    consentVersion: '2026-09-07', files: [granted('uploads/2026/11/a-flyer.jpg'), granted('uploads/2026/11/b-clip.mp4', 'video/mp4', 'clip.mp4')],
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    ...over,
  };
}

function post(payload: unknown) {
  return POST(new NextRequest('https://archive.example/api/items/bulk-upload-item', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify(payload),
  }));
}

beforeEach(() => {
  mocks.session = null;
  mocks.createItem.mockReset();
  mocks.createItem.mockResolvedValue({ id: 'item-1', title: 'Purim party, Mumbai' });
});

describe('who may call it', () => {
  it('rejects an anonymous caller', async () => {
    const response = await post(body());
    expect(response.status).toBe(401);
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('rejects a signed-in account that is still pending approval', async () => {
    signedIn('pending');
    expect((await post(body())).status).toBe(401);
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('rejects a session with no profile row', async () => {
    mocks.session = { user: { id: 'ghost' }, profile: null };
    expect((await post(body())).status).toBe(401);
  });

  it.each(['volunteer', 'admin'])('accepts a %s', async (role) => {
    signedIn(role);
    const response = await post(body());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, data: { id: 'item-1', title: 'Purim party, Mumbai' } });
  });
});

describe('what it forces', () => {
  beforeEach(() => signedIn('volunteer'));

  it('sets the expert as uploader, the derived title, dating, credit, and queued readings', async () => {
    await post(body());
    const input = mocks.createItem.mock.calls[0][0];
    expect(input).toMatchObject({
      uploadedBy: 'expert-1',
      contributorLanguage: 'he',
      title: 'Purim party, Mumbai',
      period: '1952',
      collectorCreditRequired: true,
      collectorName: 'Levi family',
      sourceUrl: 'https://youtu.be/dQw4w9WgXcQ',
      contributorDescription: 'Purim party, Mumbai\nThe Ezra family',
      contributorEmail: null,
    });
    // Status and category are not inputs at all: createItem always writes `pending`, and sets no category.
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('category');
    const [image, video] = input.files;
    expect(image).toMatchObject({ analysis: null, analysisQueued: true, noAnalysis: false, width: null, height: null });
    expect(video).toMatchObject({ analysis: null, analysisQueued: false, noAnalysis: true });
  });

  it('ignores a status or category smuggled into the body', async () => {
    await post({ ...body(), status: 'accepted', category: 'documents' });
    const input = mocks.createItem.mock.calls[0][0];
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('category');
  });

  it('refuses a file this caller was not granted', async () => {
    const forged = { ...granted('uploads/2026/11/x.jpg'), path: 'uploads/2026/11/someone-else.jpg' };
    const response = await post(body({ files: [forged] }));
    expect(response.status).toBe(403);
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('returns the rule broken, by field, as message keys', async () => {
    const response = await post(body({ period: '', periodUnknown: false, creditRequired: true, collectorName: '', files: [], youtubeUrl: 'https://vimeo.com/1' }));
    expect(response.status).toBe(400);
    const { error } = await response.json();
    // A bad YouTube link is reported as itself, not additionally as "no media".
    expect(error.fields).toEqual({
      youtube: 'bulk.err.youtube', period: 'bulk.err.period', collectorName: 'bulk.err.collector',
    });
    const none = await (await post(body({ files: [], youtubeUrl: undefined }))).json();
    expect(none.error.fields).toEqual({ media: 'bulk.err.media' });
  });

  it('says plainly when migration 0041 is missing', async () => {
    mocks.createItem.mockRejectedValue(Object.assign(new Error('invalid input value for enum analysis_status: "queued"'), { code: '22P02' }));
    const response = await post(body());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('migration_required');
  });
});
