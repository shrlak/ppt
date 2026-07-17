// Standalone usage page: shows the shared Gemini/OpenRouter/Hugging Face API
// usage, separated from AdminPanel so anyone can check it without the admin
// password.
import { useEffect, useState } from 'react';
import Modal from './Modal';
import {
  fetchAiUsage,
  hasSharedUsageMonitor,
  type AiUsageSnapshot,
  type ModelUsage,
  type UsageHistoryPoint,
} from '../lib/ai/usageMonitor';

interface Props {
  onClose: () => void;
}

const NUMBER_FORMAT = new Intl.NumberFormat('ko-KR');

const PROVIDER_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
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

/** Round up to a clean axis maximum (1/2/5 × 10^k). */
function niceCeil(value: number): number {
  if (value <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * power) return step * power;
  }
  return 10 * power;
}

/** '2026-07-16' → '7/16', '2026-07' → '7월'. */
function periodLabel(periodKey: string): string {
  const day = periodKey.match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (day) return `${Number(day[1])}/${Number(day[2])}`;
  const month = periodKey.match(/^\d{4}-(\d{2})$/);
  if (month) return `${Number(month[1])}월`;
  return periodKey;
}

/**
 * Exact request counts per period as a small column chart: one column per
 * day (or month), a clean-number axis, the peak labeled, and a hover
 * tooltip with the precise 요청/성공/실패 counts for every period.
 */
function UsageHistoryChart({ usage }: { usage: ModelUsage }) {
  const [hover, setHover] = useState<number | null>(null);
  const history: UsageHistoryPoint[] = usage.history;
  if (history.length === 0) return null;

  const WIDTH = 280;
  const HEIGHT = 96;
  const PAD_LEFT = 28;
  const PAD_RIGHT = 6;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 18;
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const baseline = PAD_TOP + plotHeight;

  const maxRequests = Math.max(...history.map((point) => point.requests));
  const axisMax = niceCeil(maxRequests);
  const band = plotWidth / history.length;
  const barWidth = Math.min(24, Math.max(3, band - 2));
  const barX = (index: number) => PAD_LEFT + index * band + (band - barWidth) / 2;
  const valueY = (value: number) => baseline - (value / axisMax) * plotHeight;
  const peakIndex = maxRequests > 0 ? history.findIndex((point) => point.requests === maxRequests) : -1;
  const caption = usage.period === 'day' ? `최근 ${history.length}일 요청` : `최근 ${history.length}개월 요청`;
  const totalRequests = history.reduce((sum, point) => sum + point.requests, 0);
  const hovered = hover != null ? history[hover] : null;

  // Column with a 4px rounded data-end and a square baseline.
  const columnPath = (index: number, value: number): string => {
    const x = barX(index);
    const y = valueY(value);
    const height = baseline - y;
    const radius = Math.min(4, barWidth / 2, height);
    return [
      `M${x} ${baseline}`,
      `L${x} ${y + radius}`,
      `Q${x} ${y} ${x + radius} ${y}`,
      `L${x + barWidth - radius} ${y}`,
      `Q${x + barWidth} ${y} ${x + barWidth} ${y + radius}`,
      `L${x + barWidth} ${baseline}`,
      'Z',
    ].join(' ');
  };

  return (
    <figure
      className="usage-history"
      aria-label={`${caption} 합계 ${NUMBER_FORMAT.format(totalRequests)}회, 최대 ${NUMBER_FORMAT.format(maxRequests)}회`}
      data-testid={`usage-history-${usage.provider}`}
    >
      <figcaption className="usage-history-caption">
        {caption} <strong>{NUMBER_FORMAT.format(totalRequests)}회</strong>
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" onMouseLeave={() => setHover(null)}>
        {/* recessive grid: top tick + baseline only */}
        <line className="usage-history-grid" x1={PAD_LEFT} y1={PAD_TOP} x2={WIDTH - PAD_RIGHT} y2={PAD_TOP} />
        <line className="usage-history-axis" x1={PAD_LEFT} y1={baseline} x2={WIDTH - PAD_RIGHT} y2={baseline} />
        <text className="usage-history-tick" x={PAD_LEFT - 4} y={PAD_TOP + 3} textAnchor="end">
          {NUMBER_FORMAT.format(axisMax)}
        </text>
        <text className="usage-history-tick" x={PAD_LEFT - 4} y={baseline + 3} textAnchor="end">
          0
        </text>
        {history.map(
          (point, index) =>
            point.requests > 0 && (
              <path
                key={point.periodKey}
                className={`usage-history-bar${hover === index ? ' hovered' : ''}`}
                d={columnPath(index, point.requests)}
              />
            ),
        )}
        {/* selective direct label: the peak only */}
        {peakIndex >= 0 && (
          <text
            className="usage-history-peak"
            x={barX(peakIndex) + barWidth / 2}
            y={valueY(history[peakIndex].requests) - 4}
            textAnchor="middle"
          >
            {NUMBER_FORMAT.format(maxRequests)}
          </text>
        )}
        <text className="usage-history-tick" x={barX(0) + barWidth / 2} y={HEIGHT - 4} textAnchor="middle">
          {periodLabel(history[0].periodKey)}
        </text>
        <text
          className="usage-history-tick"
          x={barX(history.length - 1) + barWidth / 2}
          y={HEIGHT - 4}
          textAnchor="middle"
        >
          {periodLabel(history[history.length - 1].periodKey)}
        </text>
        {/* full-height hover targets, wider than the bars */}
        {history.map((point, index) => (
          <rect
            key={`hit-${point.periodKey}`}
            x={PAD_LEFT + index * band}
            y={PAD_TOP}
            width={band}
            height={plotHeight}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          >
            <title>
              {`${periodLabel(point.periodKey)} · 요청 ${NUMBER_FORMAT.format(point.requests)}회 (성공 ${NUMBER_FORMAT.format(point.successfulRequests)} · 실패 ${NUMBER_FORMAT.format(point.failedRequests)})`}
            </title>
          </rect>
        ))}
      </svg>
      {hovered && hover != null && (
        <div
          className="usage-history-tooltip"
          style={{ left: `${((barX(hover) + barWidth / 2) / WIDTH) * 100}%` }}
          role="status"
        >
          {periodLabel(hovered.periodKey)} · 요청 {NUMBER_FORMAT.format(hovered.requests)}회
          {hovered.requests > 0 &&
            ` (성공 ${NUMBER_FORMAT.format(hovered.successfulRequests)} · 실패 ${NUMBER_FORMAT.format(hovered.failedRequests)})`}
        </div>
      )}
    </figure>
  );
}

function ModelUsageCard({ usage }: { usage: ModelUsage }) {
  const percent = usagePercent(usage);
  const level = percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'normal';
  const providerName = PROVIDER_NAMES[usage.provider] ?? usage.provider;
  const resetLabel =
    usage.period === 'day'
      ? usage.provider === 'gemini'
        ? '매일 자정(미 서부) 초기화'
        : '매일 초기화'
      : '매월 초기화';
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
      <UsageHistoryChart usage={usage} />
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
              가사 인식 때 Gemini·OpenRouter·Hugging Face 모델이 모두 동시에 실행됩니다. 아래는 공유
              키를 사용하는 모든 브라우저의 모델별 사용량입니다.
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
              Gemini와 OpenRouter 막대는 일일 요청 한도 기준입니다. 카드의 그래프는 기간별 실제 요청
              횟수를 그대로 보여주며, 막대에 마우스를 올리면 그날의 정확한 요청·성공·실패 수를 볼 수
              있습니다. Hugging Face 막대는 응답 계산 시간과 설정 단가로 추정하며, 최종 청구 내역은
              공급자 대시보드가 기준입니다.
            </p>
          </>
        )}
      </section>
    </Modal>
  );
}
