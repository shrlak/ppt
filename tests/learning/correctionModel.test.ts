import { describe, expect, it } from 'vitest';
import {
  acceptCorrectionManifest,
  correctConsensus,
  serializeCorrectionInput,
  validateCorrection,
  type CorrectionModelManifest,
} from '../../src/lib/learning/correctionModel';
import {
  acceptCorrectionManifest as workerAccept,
  matchCorrectionReadRoute,
  matchCorrectionUploadRoute,
  sanitizeCorrectionManifest,
  validFilePath,
} from '../../worker/src/correctionModel.js';
import { createWorkerHarness } from '../support/workerHarness';
import type { ParsedScore } from '../../src/lib/ai/scoreParser';
import type { RecognitionObservation } from '../../src/lib/ai/recognitionObservation';

const hash = (seed: string) =>
  [...seed].map((character) => (character.codePointAt(0)! % 16).toString(16)).join('').padEnd(64, '0');

const manifest: CorrectionModelManifest = {
  version: 'v1',
  baseModel: 'google/mt5-small',
  datasetHash: hash('dataset'),
  samples: 120,
  meanOverall: 0.94,
  baselineOverall: 0.9,
  lyricsScore: 0.93,
  baselineLyricsScore: 0.9,
  files: [
    { path: 'config.json', size: 512, sha256: hash('config') },
    { path: 'tokenizer.json', size: 1024, sha256: hash('tokenizer') },
    { path: 'onnx/model.onnx', size: 2048, sha256: hash('onnx') },
  ],
};

const consensus: ParsedScore = {
  title: '가나다라 마바사',
  order: ['I', 'V', 'C'],
  sections: [
    { label: 'V', lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높이'] },
    { label: 'C', lines: ['높이 높이 노래해'] },
  ],
};

const observations: RecognitionObservation[] = [
  { attempt: { engine: 'gemini', model: 'gemini-3.6-flash' }, score: consensus, latencyMs: 900 },
];

const answer = (score: Partial<ParsedScore>) =>
  JSON.stringify({ title: consensus.title, order: consensus.order, sections: consensus.sections, ...score });

describe('acceptCorrectionManifest', () => {
  it('rejects an artifact that regresses lyrics or improves by less than one point', () => {
    expect(acceptCorrectionManifest({ ...manifest, meanOverall: 0.905, baselineOverall: 0.9 })).toBe(false);
    expect(acceptCorrectionManifest({ ...manifest, lyricsScore: 0.89, baselineLyricsScore: 0.9 })).toBe(false);
  });

  it('accepts a real improvement that did not cost lyric accuracy', () => {
    expect(acceptCorrectionManifest(manifest)).toBe(true);
  });

  it('refuses a base model outside the allowlist', () => {
    expect(acceptCorrectionManifest({ ...manifest, baseModel: 'some/unknown-model' })).toBe(false);
  });

  it('agrees with the proxy-side gate (kept in lockstep)', () => {
    for (const candidate of [
      manifest,
      { ...manifest, meanOverall: 0.905 },
      { ...manifest, lyricsScore: 0.5 },
    ]) {
      expect(acceptCorrectionManifest(candidate)).toBe(workerAccept(candidate as never));
    }
  });
});

describe('validateCorrection', () => {
  it('accepts a single-syllable fix inside an otherwise identical reading', () => {
    const corrected: ParsedScore = {
      ...consensus,
      sections: [
        { label: 'V', lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높여'] },
        consensus.sections[1],
      ],
    };
    expect(validateCorrection(corrected, consensus)).toBe(true);
  });

  it('refuses output that lost a part, which would lose a slide', () => {
    expect(validateCorrection({ ...consensus, sections: [consensus.sections[0]] }, consensus)).toBe(false);
    expect(validateCorrection({ ...consensus, sections: [] }, consensus)).toBe(false);
  });

  it('refuses a line rewritten past recognition', () => {
    const wild: ParsedScore = {
      ...consensus,
      sections: [
        { label: 'V', lines: ['전혀 다른 문장으로 교체함', '카타파하 그 이름 높이'] },
        consensus.sections[1],
      ],
    };
    expect(validateCorrection(wild, consensus)).toBe(false);
  });

  it('refuses lyrics that grew by more than a fifth, which looks like invention', () => {
    const padded: ParsedScore = {
      ...consensus,
      sections: [
        {
          label: 'V',
          lines: [
            ...consensus.sections[0].lines,
            '지어낸 줄 하나',
            '지어낸 줄 둘',
            '지어낸 줄 셋',
            '지어낸 줄 넷',
          ],
        },
        consensus.sections[1],
      ],
    };
    expect(validateCorrection(padded, consensus)).toBe(false);
  });

  it('refuses a retitle when the models were sure about the title', () => {
    const retitled = { ...consensus, title: '완전히 다른 제목' };
    expect(validateCorrection(retitled, consensus, { titleConfidence: 0.95 })).toBe(false);
    // With an unsure title, proposing a different one is exactly its job.
    expect(validateCorrection(retitled, consensus, { titleConfidence: 0.4 })).toBe(true);
  });
});

describe('correctConsensus', () => {
  it('falls back to consensus when corrected output is invalid or less similar', async () => {
    const badRunner = async () => answer({ sections: [{ label: 'V', lines: ['전혀 다른 문장입니다'] }] });
    expect(await correctConsensus(consensus, observations, badRunner)).toEqual(consensus);
  });

  it('is a no-op when this deployment has no model at all', async () => {
    expect(await correctConsensus(consensus, observations, null)).toBe(consensus);
  });

  it('applies a correction that survives every guard', async () => {
    const fixed = [
      { label: 'V', lines: ['가나다라 마바사 아자차', '카타파하 그 이름 높여'] },
      consensus.sections[1],
    ];
    const runner = async () => answer({ sections: fixed });
    const result = await correctConsensus(consensus, observations, runner);
    expect(result.sections[0].lines[1]).toBe('카타파하 그 이름 높여');
    // The score still decides the printed order, never the model.
    expect(result.order).toEqual(consensus.order);
  });

  it('keeps consensus when the model answers with something unparseable', async () => {
    expect(await correctConsensus(consensus, observations, async () => 'not json at all')).toEqual(consensus);
    expect(await correctConsensus(consensus, observations, async () => '')).toEqual(consensus);
  });

  it('keeps consensus when the model throws', async () => {
    const runner = async () => {
      throw new Error('runtime exploded');
    };
    expect(await correctConsensus(consensus, observations, runner)).toEqual(consensus);
  });

  it('asks with the exact serialization the notebook trains on', () => {
    const input = JSON.parse(serializeCorrectionInput(consensus, observations));
    expect(input.task).toBe('correct-korean-worship-lyrics');
    expect(Object.keys(input)).toEqual(['task', 'consensus', 'readings']);
    expect(Object.keys(input.consensus)).toEqual(['title', 'artist', 'key', 'order', 'sections']);
    expect(input.readings[0].model).toBe('gemini:gemini-3.6-flash');
  });

  it('leaves a failed model call out of the serialized readings', () => {
    const failed: RecognitionObservation[] = [
      ...observations,
      { attempt: { engine: 'openrouter', model: 'x' }, error: 'quota', latencyMs: 10 },
    ];
    expect(JSON.parse(serializeCorrectionInput(consensus, failed)).readings).toHaveLength(1);
  });
});

describe('proxy-side artifact validation', () => {
  const uploadable = {
    ...manifest,
    files: manifest.files.map((file) => ({ ...file })),
  };

  it('requires the files the runtime cannot start without', () => {
    expect(sanitizeCorrectionManifest(uploadable)).not.toBeNull();
    expect(
      sanitizeCorrectionManifest({
        ...uploadable,
        files: uploadable.files.filter((file) => file.path !== 'tokenizer.json'),
      }),
    ).toBeNull();
    expect(
      sanitizeCorrectionManifest({
        ...uploadable,
        files: uploadable.files.filter((file) => !file.path.endsWith('.onnx')),
      }),
    ).toBeNull();
  });

  it('refuses a file path that could escape the artifact', () => {
    expect(validFilePath('onnx/model.onnx')).toBe(true);
    expect(validFilePath('../secrets')).toBe(false);
    expect(validFilePath('/etc/passwd')).toBe(false);
    expect(validFilePath('a//b')).toBe(false);
    expect(matchCorrectionUploadRoute('/learning/correction-model/v1/files/../x/chunks/0')).toBeNull();
  });

  it('routes upload and read paths', () => {
    expect(matchCorrectionUploadRoute('/learning/correction-model/v1/files/config.json/chunks/0')).toEqual({
      version: 'v1',
      path: 'config.json',
      index: 0,
    });
    expect(matchCorrectionReadRoute('/learning/correction-model/v1/resolve/onnx/model.onnx')).toEqual({
      version: 'v1',
      path: 'onnx/model.onnx',
    });
  });
});

describe('the correction model over the proxy', () => {
  const small = {
    version: 'v1',
    baseModel: 'google/mt5-small',
    datasetHash: hash('dataset'),
    samples: 120,
    meanOverall: 0.94,
    baselineOverall: 0.9,
    lyricsScore: 0.93,
    baselineLyricsScore: 0.9,
    files: [
      { path: 'config.json', size: 3, sha256: hash('config') },
      { path: 'tokenizer.json', size: 3, sha256: hash('tokenizer') },
      { path: 'onnx/model.onnx', size: 3, sha256: hash('onnx') },
    ],
  };

  async function upload(harness: ReturnType<typeof createWorkerHarness>, version = 'v1') {
    const staged = await harness.fetch('/learning/correction-model', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ manifest: { ...small, version } }),
    });
    for (const file of small.files) {
      await harness.fetch(`/learning/correction-model/${version}/files/${file.path}/chunks/0`, {
        method: 'PUT',
        admin: true,
        body: new Uint8Array([1, 2, 3]),
      });
    }
    return staged;
  }

  it('refuses to stage an artifact that made things worse', async () => {
    const harness = createWorkerHarness();
    const response = await harness.fetch('/learning/correction-model', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ manifest: { ...small, meanOverall: 0.9005 } }),
    });
    expect(response.status).toBe(400);
    // A client that skipped its own check must not be able to activate it.
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('improve') });
  });

  it('will not activate a half-uploaded version', async () => {
    const harness = createWorkerHarness();
    await harness.fetch('/learning/correction-model', {
      method: 'PUT',
      admin: true,
      body: JSON.stringify({ manifest: small }),
    });
    const activate = await harness.fetch('/learning/correction-model/activate', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ version: 'v1' }),
    });
    expect(activate.status).toBe(400);
    const slots = (await (await harness.fetch('/learning/correction-model')).json()) as { active: unknown };
    expect(slots.active).toBeNull();
  });

  it('activates a complete upload and serves its files immutably', async () => {
    const harness = createWorkerHarness();
    await upload(harness);
    const activate = await harness.fetch('/learning/correction-model/activate', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ version: 'v1' }),
    });
    expect(activate.status).toBe(200);

    const file = await harness.fetch('/learning/correction-model/v1/resolve/config.json');
    expect(file.status).toBe(200);
    expect(file.headers.get('Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rolls back to the previous version in one request', async () => {
    const harness = createWorkerHarness();
    for (const version of ['v1', 'v2']) {
      await upload(harness, version);
      await harness.fetch('/learning/correction-model/activate', {
        method: 'POST',
        admin: true,
        body: JSON.stringify({ version }),
      });
    }
    const rolled = (await (
      await harness.fetch('/learning/correction-model/rollback', { method: 'POST', admin: true })
    ).json()) as { active: { version: string }; previous: { version: string } };
    expect(rolled.active.version).toBe('v1');
    expect(rolled.previous.version).toBe('v2');
  });

  it('needs the administrator password to upload or activate', async () => {
    const harness = createWorkerHarness();
    expect(
      (
        await harness.fetch('/learning/correction-model', {
          method: 'PUT',
          body: JSON.stringify({ manifest: small }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.fetch('/learning/correction-model/activate', {
          method: 'POST',
          body: JSON.stringify({ version: 'v1' }),
        })
      ).status,
    ).toBe(403);
  });

  it('reports no model at all before anything is uploaded', async () => {
    const harness = createWorkerHarness();
    expect(await (await harness.fetch('/learning/correction-model')).json()).toEqual({
      active: null,
      previous: null,
    });
  });
});
