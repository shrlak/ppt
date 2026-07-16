// Standalone usage page: shows the shared Gemini/NVIDIA/Hugging Face API
// usage, separated from AdminPanel so anyone can check it without the admin
// password.
import { useEffect, useState } from 'react';
import Modal from './Modal';
import { fetchAiUsage, hasSharedUsageMonitor, type AiUsageSnapshot, type ModelUsage } from '../lib/ai/usageMonitor';

interface Props {
  onClose: () => void;
}

const NUMBER_FORMAT = new Intl.NumberFormat('ko-KR');

const PROVIDER_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  nvidia: 'NVIDIA',
  huggingface: 'Hugging Face',
};

function usagePercent(usage: ModelUsage): number {
  if (usage.limit <= 0) return 0;
  return Math.min(100, Math.max(0, (usage.used / usage.limit) * 100));
}

function usageHeadline(usage: ModelUsage): string {
  if (usage.metric === 'usd') {
    return `$${usage.used.toFixed(4)} / $${usage.limit.toFixed(2)}`;
  }
  return `${NUMBER_FORMAT.format(Math.round(usage.used))} / ${NUMBER_FORMAT.format(Math.round(usage.limit))}회`;
}

function ModelUsageCard({ usage }: { usage: ModelUsage }) {
  const percent = usagePercent(usage);
  const level = percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'normal';
  const providerName = PROVIDER_NAMES[usage.provider] ?? usage.provider;
  const resetLabel = usage.period === 'day' ? '매일 자정(미 서부) 초기화' : '매월 초기화';
  const details =
    usage.provider === 'huggingface'
      ? `요청 ${NUMBER_FORMAT.format(usage.requests)}회 · 성공 ${NUMBER_FORMAT.format(usage.successfulRequests)}회 · 계산 ${usage.computeSeconds.toFixed(1)}초`
      : `요청 ${NUMBER_FORMAT.format(usage.requests)}회 · 성공 ${NUMBER_FORMAT.format(usage.successfulRequests)}회 · 토큰 ${NUMBER_FORMAT.format(usage.totalTokens)}개`;

  return (
    <article className={`admin-usage-card usage-${level}`} data-testid={`admin-usage-${usage.provider}`}>
      <div className="admin-usage-card-heading">
        <span className={`admin-provider-badge provider-${usage.provider}`}>{providerName}</span>
        {usage.estimated && <span className="admin-estimate-badge">비용 추정</span>}
      </div>
      <strong className="admin-usage-model">{usage.model}</strong>
      <div className="admin-usage-value">
        <strong>{usageHeadline(usage)}</strong>
        <span>{percent.toFixed(0)}%</span>
      </div>
      <div
        className="admin-usage-track"
        role="progressbar"
        aria-label={`${providerName} ${usage.model} 무료 한도 사용량`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="admin-usage-details">{details}</p>
      <p className="admin-usage-reset">{resetLabel}</p>
    </article>
  );
}

export default function UsagePanel({ onClose }: Props) {
  const [snapshot, setSnapshot] = useState<AiUsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      setSnapshot(await fetchAiUsage(signal));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <Modal title="AI 사용량" onClose={onClose}>
      <section className="admin-usage" data-testid="admin-ai-usage">
        <div className="admin-usage-heading">
          <div>
            <h4>무료 API 사용량</h4>
            <p>
              가사 인식은 Gemini를 우선 사용하고, 토큰·한도가 소진되면 NVIDIA → Hugging Face 순으로
              자동 전환됩니다. 아래는 공유 키를 사용하는 모든 브라우저의 모델별 사용량입니다.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-chip"
            disabled={loading || !hasSharedUsageMonitor()}
            data-testid="admin-usage-refresh"
            onClick={() => void refresh()}
          >
            {loading ? '확인 중…' : '새로고침'}
          </button>
        </div>
        {error && (
          <div className="admin-usage-error" role="status" data-testid="admin-usage-error">
            {error}
          </div>
        )}
        {snapshot && (
          <>
            <div className="admin-usage-grid">
              {snapshot.models.map((usage) => (
                <ModelUsageCard key={`${usage.provider}:${usage.model}`} usage={usage} />
              ))}
            </div>
            <p className="admin-usage-note">
              Gemini 막대는 AI Studio의 일일 요청 한도 기준입니다. NVIDIA 막대는 build.nvidia.com
              무료 크레딧(요청 1회 = 1크레딧) 기준입니다. Hugging Face 막대는 응답 계산 시간과
              설정 단가로 추정하며, 최종 청구 내역은 공급자 대시보드가 기준입니다.
            </p>
          </>
        )}
      </section>
    </Modal>
  );
}
