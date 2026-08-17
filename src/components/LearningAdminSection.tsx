// The administrator's view of what recognition has learned.
//
// Three questions this has to answer at a glance: which models are actually
// being used and how well they read, how much verified training data exists,
// and whether this deployment is allowed to read Bugs pages. Everything is
// read from the shared proxy, so two administrators see the same picture.
import { useCallback, useEffect, useState } from 'react';
import {
  RECOGNITION_MODEL_CATALOG,
  findModelInfo,
  type ModelRole,
  type SharedRecognitionSettings,
} from '../lib/ai/aiSettings';
import {
  MIN_CHAMPION_SAMPLES,
  rankModels,
  type ModelReliability,
  type RankedModel,
} from '../lib/ai/modelReliability';
import {
  fetchModelReliabilities,
  fetchTrainingCorpusStatus,
  learningFetch,
  hasLearningProxy,
  type TrainingCorpusStatus,
} from '../lib/learning/learningClient';
import { ADMIN_PASSWORD } from '../lib/adminAuth';
import { exportTrainingCorpus, type TrainingExportEntry } from '../lib/learning/trainingCorpus';
import { showToast } from '../lib/utils/toast';

/** Verified pages that make a new training run worth doing. */
const RECOMMEND_TRAINING_AT = 100;

/** New pages since the last export that make a re-run worth doing. */
const RECOMMEND_NEW_SINCE_EXPORT = 20;

const ROLE_LABELS: Record<ModelRole, string> = {
  champion: '주 모델',
  challenger: '교차 검증',
  paused: '중지됨',
};

const PAUSE_REASONS: Record<string, string> = {
  failures: '최근 호출 실패가 잦아 자동 중지',
  regression: '정확도가 이전보다 떨어져 자동 중지',
};

function percent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

interface Props {
  settings: SharedRecognitionSettings;
  onRoleOverride: (modelKey: string, role: ModelRole | null) => void;
  /** Whether this deployment may read Bugs pages, as the proxy reports it. */
  bugsScrapingAllowed: boolean;
}

export default function LearningAdminSection({ settings, onRoleOverride, bugsScrapingAllowed }: Props) {
  const [stats, setStats] = useState<ModelReliability[] | null>(null);
  const [corpus, setCorpus] = useState<TrainingCorpusStatus | null>(null);
  const [exporting, setExporting] = useState(false);

  const refresh = useCallback(async () => {
    const [models, status] = await Promise.all([fetchModelReliabilities(), fetchTrainingCorpusStatus()]);
    setStats(models);
    setCorpus(status);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ranked = rankModels(RECOGNITION_MODEL_CATALOG, stats ?? []);

  /**
   * Build the ZIP in the browser from the proxy's records, and only mark them
   * exported once the download has actually been handed over — a failed
   * export must not make records evictable.
   */
  const exportCorpus = useCallback(async () => {
    setExporting(true);
    try {
      const response = await learningFetch('/learning/corpus/manifests', {
        method: 'GET',
        headers: { Authorization: `Bearer ${ADMIN_PASSWORD}` },
      });
      if (!response?.ok) throw new Error('학습 자료 목록을 불러오지 못했습니다.');
      const { manifests } = (await response.json()) as { manifests: TrainingExportEntry['manifest'][] };
      if (manifests.length === 0) throw new Error('내보낼 학습 자료가 아직 없습니다.');

      const entries: TrainingExportEntry[] = [];
      for (const manifest of manifests) {
        entries.push({ manifest, image: await downloadCorpusImage(manifest) });
      }
      const blob = await exportTrainingCorpus(entries);
      downloadBlob(blob, `lyrics-training-${new Date().toISOString().slice(0, 10)}.zip`);

      await learningFetch('/learning/corpus/exported', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_PASSWORD}` },
        body: JSON.stringify({ ids: manifests.map((manifest) => manifest.id) }),
      });
      await refresh();
      showToast(`학습 자료 ${manifests.length}건을 내려받았습니다.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }, [refresh]);

  const sinceExport = corpus ? corpus.total - corpus.exported : 0;
  const recommendTraining =
    !!corpus && corpus.total >= RECOMMEND_TRAINING_AT && sinceExport >= RECOMMEND_NEW_SINCE_EXPORT;

  return (
    <>
      <section className="admin-deck admin-recognition" data-testid="admin-learning-models">
        <div className="admin-deck-info">
          <h4>모델 정확도</h4>
          <p>
            사용자가 검증한 가사와 대조해 측정한 값입니다. 표본이 {MIN_CHAMPION_SAMPLES}건을 넘으면
            이 수치가 역할을 정하고, 그 전에는 기본 역할을 사용합니다. 아래 순서는 표본 수를 감안한
            보수적 점수 기준입니다.
          </p>
          {!hasLearningProxy() && (
            <p className="admin-sync admin-sync-local" role="status">
              공유 프록시 미연결 — 측정값 없이 기본 역할로 동작합니다.
            </p>
          )}
          <ul className="learning-model-list">
            {ranked.map((model) => (
              <ModelRow
                key={model.modelKey}
                model={model}
                override={settings.roleOverrides[model.modelKey]}
                onRoleOverride={onRoleOverride}
              />
            ))}
          </ul>
        </div>
      </section>

      <section className="admin-deck admin-recognition" data-testid="admin-learning-corpus">
        <div className="admin-deck-info">
          <h4>학습 자료</h4>
          <p>
            사용자가 <strong>직접 저장</strong>한 가사만 모읍니다. 자동 인식 결과(초안)는 포함되지
            않습니다. 악보 이미지는 {corpus?.limit ?? 300}장까지 보관하며, 이미 내보낸 오래된 것부터
            비웁니다.
          </p>
          <p className="learning-corpus-count" data-testid="training-corpus-count">
            {corpus
              ? `검증 ${corpus.verified} · 수정 ${corpus.edited} · 이미지 ${corpus.withImage}장 ` +
                `(${Math.round(corpus.bytes / 1024)}KB) · 내보냄 ${corpus.exported}`
              : '불러오는 중…'}
          </p>
          {recommendTraining && (
            <p className="admin-sync admin-sync-synced" data-testid="training-recommended" role="status">
              새 학습 권장 — 검증 {corpus?.total}건 중 {sinceExport}건이 마지막 내보내기 이후에
              추가되었습니다.
            </p>
          )}
          <div className="admin-actions">
            <button
              type="button"
              className="btn"
              data-testid="training-export"
              disabled={exporting}
              onClick={() => void exportCorpus()}
            >
              {exporting ? '내보내는 중…' : '학습 자료 ZIP 내려받기'}
            </button>
          </div>
        </div>
      </section>

      <section className="admin-deck admin-recognition" data-testid="admin-learning-sources">
        <div className="admin-deck-info">
          <h4>웹 가사 출처</h4>
          <p data-testid="bugs-permission">
            벅스 자동 수집: <strong>{bugsScrapingAllowed ? '활성' : '비활성'}</strong>
          </p>
          <p>
            {/* Deliberately not a switch. Permission to read a commercial
                service's pages is a deployment decision recorded in the
                Worker's environment; a client toggle would step around it. */}
            이 설정은 서버(Worker) 환경 변수 <code>BUGS_SCRAPING_ALLOWED</code>로만 바꿀 수 있습니다.
            비활성 상태에서는 벅스 검색 결과를 링크로만 보여 주고 페이지를 읽지 않습니다.
          </p>
        </div>
      </section>
    </>
  );
}

function ModelRow({
  model,
  override,
  onRoleOverride,
}: {
  model: RankedModel;
  override?: ModelRole;
  onRoleOverride: Props['onRoleOverride'];
}) {
  const info = findModelInfo({ engine: model.engine, model: model.model });
  const reliability = model.reliability;
  const measured = model.samples >= MIN_CHAMPION_SAMPLES;
  const role: ModelRole = override ?? (model.paused ? 'paused' : model.catalogRole);

  return (
    <li className="learning-model" data-testid={`learning-model-${role}`} data-role={role}>
      <div className="learning-model-head">
        <span className="learning-model-name">{info?.label ?? model.model}</span>
        {/* The role is spelled out, so the row does not rely on colour. */}
        <span className={`learning-model-role learning-model-role-${role}`}>
          {ROLE_LABELS[role]}
          {override && <span className="learning-model-pinned"> (고정)</span>}
        </span>
      </div>
      <p className="learning-model-stats">
        {reliability && model.samples > 0 ? (
          <>
            표본 {Math.round(model.samples)}건 · 제목 {percent(reliability.title)} · 아티스트{' '}
            {reliability.artistSamples > 0 ? percent(reliability.artist) : '—'} · 순서{' '}
            {percent(reliability.order)} · 가사 {percent(reliability.lyrics)} · 실패{' '}
            {percent(1 - reliability.successRate)} · 보수 점수 {percent(model.conservative)}
            {!measured && ' · 표본 부족'}
          </>
        ) : (
          '아직 측정된 표본이 없습니다.'
        )}
      </p>
      {model.paused && reliability?.pausedReason && (
        <p className="learning-model-paused">{PAUSE_REASONS[reliability.pausedReason]}</p>
      )}
      <div className="admin-actions">
        {(['champion', 'challenger', 'paused'] as ModelRole[]).map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={`btn btn-chip${override === candidate ? ' is-selected' : ''}`}
            aria-pressed={override === candidate}
            onClick={() => onRoleOverride(model.modelKey, override === candidate ? null : candidate)}
          >
            {ROLE_LABELS[candidate]} 고정
          </button>
        ))}
      </div>
    </li>
  );
}

/** Pull one record's stored page image back out of the proxy, chunk by chunk. */
async function downloadCorpusImage(
  manifest: TrainingExportEntry['manifest'],
): Promise<Uint8Array | undefined> {
  if (!manifest.image) return undefined;
  const parts: Uint8Array[] = [];
  for (let index = 0; index < manifest.image.chunkCount; index += 1) {
    const response = await learningFetch(
      `/learning/corpus/${encodeURIComponent(manifest.id)}/chunks/${index}`,
      { method: 'GET', headers: { Authorization: `Bearer ${ADMIN_PASSWORD}` } },
    );
    // A missing chunk means this record exports as metadata only, rather than
    // failing the whole archive.
    if (!response?.ok) return undefined;
    parts.push(new Uint8Array(await response.arrayBuffer()));
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
