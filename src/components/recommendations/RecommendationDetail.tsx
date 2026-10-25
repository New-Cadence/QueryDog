import { useState, type ReactNode } from 'react';
import { BellOff, Check, CheckCheck, Copy, RotateCcw, SquareTerminal, X, XCircle } from 'lucide-react';
import { Pill, ToolbarButton } from '../ui';
import { formatDateTime } from '../../utils/formatters';
import { CATEGORY_META, SEVERITY_TONE, STATUS_TONE, formatMoney, looksLikeSql } from './meta';
import type { RecommendationRow } from './types';

export type TriageAction = 'acknowledge' | 'snooze' | 'dismiss' | 'reopen';

function openInQueryEditor(sql: string) {
  (window as unknown as { openQueryEditor?: (query: string) => void }).openQueryEditor?.(sql);
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-xs text-gray-200 break-words">{children}</div>
    </div>
  );
}

export function RecommendationDetail({
  row,
  onAction,
  onClose,
}: {
  row: RecommendationRow;
  onAction: (action: TriageAction) => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const meta = CATEGORY_META[row.category];
  const CategoryIcon = meta.icon;
  const isCode = row.remediationFormat === 'code';
  const isSql = !isCode && !!row.remediation && looksLikeSql(row.remediation);

  const copy = () => {
    if (!row.remediation) return;
    navigator.clipboard.writeText(row.remediation).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };

  return (
    <div className="w-[440px] shrink-0 bg-gray-900 border border-gray-700 rounded-lg flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-2 px-3 py-2 border-b border-gray-700">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <Pill tone={SEVERITY_TONE[row.severity]}>{row.severity}</Pill>
            <span className={`flex items-center gap-1 text-[11px] ${meta.text}`}>
              <CategoryIcon className="w-3 h-3" />
              {meta.label}
            </span>
            <Pill tone={STATUS_TONE[row.status]}>{row.status}</Pill>
          </div>
          <h3 className="text-sm font-semibold text-white">{row.title}</h3>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white shrink-0" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          {row.target && <DetailField label="Target"><span className="font-mono">{row.target}</span></DetailField>}
          {row.impact && <DetailField label="Impact">{row.impact}</DetailField>}
          {!!row.estimatedMonthlySaving && (
            <DetailField label="Estimated saving"><span className="text-emerald-400">{formatMoney(row.estimatedMonthlySaving)}/month</span></DetailField>
          )}
          <DetailField label="First seen">{formatDateTime(row.firstSeen)}</DetailField>
          <DetailField label="Last seen">{formatDateTime(row.lastSeen)}</DetailField>
          {row.status === 'snoozed' && row.snoozeUntil && <DetailField label="Snoozed until">{row.snoozeUntil}</DetailField>}
          {row.status === 'dismissed' && row.reason && <DetailField label="Dismissed because">{row.reason}</DetailField>}
        </div>

        <DetailField label="Detail">
          <p className="whitespace-pre-wrap text-gray-300 leading-relaxed">{row.detail}</p>
        </DetailField>

        {row.remediation && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-gray-500 uppercase tracking-wide">Remediation</span>
              <button onClick={copy} className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-white" title="Copy to clipboard">
                {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {isSql || isCode ? (
              <pre className="bg-gray-950 border border-gray-700 rounded p-2 text-[11px] font-mono text-gray-200 whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
                {row.remediation}
              </pre>
            ) : (
              <p className="text-xs text-gray-300 whitespace-pre-wrap">{row.remediation}</p>
            )}
            {isSql && (
              <div className="mt-2 flex items-center gap-2">
                <ToolbarButton icon={SquareTerminal} variant="primary" onClick={() => openInQueryEditor(row.remediation!)}>
                  Open in Query Editor
                </ToolbarButton>
                <span className="text-[11px] text-gray-500">Review before running</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-t border-gray-700">
        {row.status === 'open' && <ToolbarButton icon={CheckCheck} onClick={() => onAction('acknowledge')}>Acknowledge</ToolbarButton>}
        {row.status !== 'resolved' && <ToolbarButton icon={BellOff} onClick={() => onAction('snooze')}>Snooze</ToolbarButton>}
        {row.status !== 'resolved' && row.status !== 'dismissed' && (
          <ToolbarButton icon={XCircle} onClick={() => onAction('dismiss')}>Dismiss</ToolbarButton>
        )}
        {row.status !== 'open' && row.status !== 'resolved' && (
          <ToolbarButton icon={RotateCcw} onClick={() => onAction('reopen')}>Reopen</ToolbarButton>
        )}
        {row.status === 'resolved' && <span className="text-[11px] text-gray-500">No longer reported by the last run</span>}
      </div>
    </div>
  );
}
