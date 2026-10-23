import { describe, expect, it } from 'vitest';
import { createWorkerHarness } from '../support/workerHarness';

const entry = { title: '등록 테스트 찬양', sections: [{ label: 'V', lines: ['확인한 가사'] }], order: ['V'], verification: 'verified' };
const put = (value = entry): RequestInit => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry: value }) });

describe('password-free song registration', () => {
  it('registers and updates a confirmed song without an administrator token', async () => {
    const worker = createWorkerHarness();
    expect((await worker.fetch('/libraries/lyrics', put())).status).toBe(200);
    const edited = { ...entry, sections: [{ label: 'V', lines: ['수정한 가사'] }] };
    expect((await worker.fetch('/libraries/lyrics', put(edited))).status).toBe(200);
    const library = await (await worker.fetch('/libraries/lyrics')).json();
    expect(library.entries).toHaveLength(1);
    expect(library.entries[0].sections).toEqual(edited.sections);
  });
  it('keeps deletion and bulk migration administrator-only', async () => {
    const worker = createWorkerHarness();
    await worker.fetch('/libraries/lyrics', put());
    const deletion = { method: 'DELETE', body: JSON.stringify({ title: entry.title }) };
    expect((await worker.fetch('/libraries/lyrics', deletion)).status).toBe(403);
    expect((await worker.fetch('/libraries/lyrics', { method: 'POST', body: JSON.stringify({ entries: [entry] }) })).status).toBe(403);
    expect((await worker.fetch('/libraries/lyrics', { ...deletion, admin: true })).status).toBe(200);
  });
  it('still rejects unapproved browser origins', async () => {
    const worker = createWorkerHarness();
    expect((await worker.fetch('/libraries/lyrics', { ...put(), headers: { Origin: 'https://other.example' } })).status).toBe(403);
  });
  it('does not let an unconfirmed recognition draft overwrite confirmed lyrics', async () => {
    const worker = createWorkerHarness();
    await worker.fetch('/libraries/lyrics', put());
    await worker.fetch('/libraries/lyrics', put({ ...entry, verification: 'draft', sections: [{ label: 'V', lines: ['틀린 AI 가사'] }] }));
    const library = await (await worker.fetch('/libraries/lyrics')).json();
    expect(library.entries[0].sections).toEqual(entry.sections);
  });
});
