import { useMemo } from 'react';
import { Settings2, Save, CopyPlus, Trash2, RefreshCw } from 'lucide-react';
import { Panel, Field, Pill } from '../ui';
import { inputClass } from '../uiTokens';
import { PATTERNS, SOURCE_LABEL, usesRampUp, vusAt, fmtMs } from './model';
import type { Calibration, MixEntry, SavedScenario, Scenario } from './model';
import { MAX_SIM_QPS, estimateCalibration } from './engine';

const smallInput = 'bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-[11px] text-white text-right disabled:opacity-50';

interface Props {
  scenario: Scenario;
  onChange: (s: Scenario) => void;
  disabled: boolean;
  calibration: Record<string, Calibration>;
  calibrating: boolean;
  calibrationNote: string | null;
  onRecalibrate: () => void;
  poolNote: string;
  library: SavedScenario[];
  currentId: string | null;
  dirty: boolean;
  onLoad: (id: string) => void;
  onSave: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function ScenarioPanel({
  scenario, onChange, disabled, calibration, calibrating, calibrationNote, onRecalibrate, poolNote,
  library, currentId, dirty, onLoad, onSave, onDuplicate, onDelete,
}: Props) {
  const set = <K extends keyof Scenario>(k: K, v: Scenario[K]) => onChange({ ...scenario, [k]: v });
  const setEntry = (name: string, patch: Partial<MixEntry>) =>
    onChange({ ...scenario, mix: scenario.mix.map(m => (m.name === name ? { ...m, ...patch } : m)) });
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const optional = (v: string) => (v === '' ? null : Math.max(0, Number(v)));

  const totalWeight = scenario.mix.filter(m => m.enabled).reduce((s, m) => s + m.weight, 0) || 1;
  const current = library.find(s => s.id === currentId);
  const builtIns = library.filter(s => s.builtIn);
  const saved = library.filter(s => !s.builtIn);

  return (
    <Panel title="Scenario" icon={Settings2} className="w-80 shrink-0" bodyClassName="overflow-y-auto p-3 space-y-3">
      <Field label="Library" hint={current ? (dirty ? 'Unsaved changes' : current.description) : 'Not saved yet'}>
        <select value={currentId ?? ''} disabled={disabled} onChange={e => e.target.value && onLoad(e.target.value)} className={inputClass}>
          <option value="">(unsaved scenario)</option>
          <optgroup label="Built-in presets">
            {builtIns.map(s => <option key={s.id} value={s.id}>{s.scenario.name}</option>)}
          </optgroup>
          {saved.length > 0 && (
            <optgroup label="Saved">
              {saved.map(s => <option key={s.id} value={s.id}>{s.scenario.name}</option>)}
            </optgroup>
          )}
        </select>
      </Field>
      <div className="flex gap-1.5">
        <LibButton icon={Save} onClick={onSave} disabled={disabled}
          title={current && !current.builtIn ? 'Overwrite the saved scenario' : 'Save as a new scenario'}>Save</LibButton>
        <LibButton icon={CopyPlus} onClick={onDuplicate} disabled={disabled} title="Save a copy and switch to it">Duplicate</LibButton>
        <LibButton icon={Trash2} onClick={onDelete} disabled={disabled || !current || current.builtIn} title="Delete the saved scenario">Delete</LibButton>
      </div>

      <Field label="Name"><input value={scenario.name} onChange={e => set('name', e.target.value)} className={inputClass} disabled={disabled} /></Field>
      <div>
        <span className="block text-[11px] text-gray-400 mb-1">Load pattern</span>
        <div className="grid grid-cols-5 gap-1">
          {PATTERNS.map(({ id }) => (
            <button key={id} type="button" disabled={disabled} onClick={() => set('pattern', id)}
              className={`px-1 py-1 rounded text-[10px] capitalize border disabled:opacity-60 ${scenario.pattern === id ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-600 text-gray-400 hover:text-white'}`}>
              {id}
            </button>
          ))}
        </div>
        <span className="block text-[10px] text-gray-500 mt-0.5">{PATTERNS.find(p => p.id === scenario.pattern)?.hint}</span>
      </div>
      <PatternPreview scenario={scenario} />
      <Field label={`Virtual users: ${scenario.virtualUsers}`}>
        <input type="range" min={1} max={500} value={scenario.virtualUsers} disabled={disabled} onChange={e => set('virtualUsers', Number(e.target.value))} className="w-full accent-blue-500" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Duration (s)"><input type="number" min={5} value={scenario.durationSec} disabled={disabled} onChange={e => set('durationSec', Math.max(1, num(e.target.value)))} className={inputClass} /></Field>
        <Field label="Ramp-up (s)" hint={usesRampUp(scenario.pattern) ? undefined : 'Not used by this pattern'}>
          <input type="number" min={0} value={scenario.rampUpSec} disabled={disabled || !usesRampUp(scenario.pattern)} onChange={e => set('rampUpSec', Math.max(0, num(e.target.value)))} className={inputClass} />
        </Field>
        <Field label="Think time (ms)"><input type="number" min={0} value={scenario.thinkTimeMs} disabled={disabled} onChange={e => set('thinkTimeMs', Math.max(0, num(e.target.value)))} className={inputClass} /></Field>
        <Field label="QPS cap"><input type="number" min={1} max={MAX_SIM_QPS} value={scenario.maxQps} disabled={disabled} onChange={e => set('maxQps', Math.min(MAX_SIM_QPS, Math.max(1, num(e.target.value))))} className={inputClass} /></Field>
      </div>
      <Field label="Simulated cluster capacity (concurrent queries)" hint="Notional: latency climbs and errors start as in-flight queries exceed it">
        <input type="number" min={1} value={scenario.capacity} disabled={disabled} onChange={e => set('capacity', Math.max(1, num(e.target.value)))} className={inputClass} />
      </Field>

      <div className="border-t border-gray-700 pt-3">
        <div className="text-[11px] text-gray-400 mb-2 font-medium">Pass criteria (whole run)</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="p95 below (ms)"><input type="number" min={1} value={scenario.p95ThresholdMs} disabled={disabled} onChange={e => set('p95ThresholdMs', Math.max(1, num(e.target.value)))} className={inputClass} /></Field>
          <Field label="Errors below (%)"><input type="number" min={0} step={0.1} value={scenario.errorThresholdPct} disabled={disabled} onChange={e => set('errorThresholdPct', Math.max(0, num(e.target.value)))} className={inputClass} /></Field>
        </div>
      </div>

      <div className="border-t border-gray-700 pt-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-gray-400 font-medium">Query mix</span>
          <button type="button" onClick={onRecalibrate} disabled={disabled || calibrating} title="Re-read latency baselines"
            className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-white disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${calibrating ? 'animate-spin' : ''}`} />{calibrating ? 'Calibrating' : 'Recalibrate'}
          </button>
        </div>
        <div className="text-[10px] text-gray-500 mb-2">
          {poolNote} Baselines come from system.query_log, else QueryDog run stats, else an estimate.
          {calibrationNote && <span className="block text-yellow-400 mt-0.5" title={calibrationNote}>query_log unavailable: {calibrationNote.slice(0, 80)}</span>}
        </div>
        <div className="space-y-2">
          {scenario.mix.map(m => {
            const cal = calibration[m.sql] ?? estimateCalibration(m.sql);
            return (
              <div key={m.name} className={m.enabled ? '' : 'opacity-60'}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={m.enabled} disabled={disabled} onChange={e => setEntry(m.name, { enabled: e.target.checked })} />
                  <span className="text-[11px] font-mono text-gray-300 truncate flex-1" title={m.sql}>{m.name}</span>
                  <input type="number" min={1} value={m.weight} disabled={disabled || !m.enabled} title="Relative weight"
                    onChange={e => setEntry(m.name, { weight: Math.max(1, num(e.target.value)) })} className={`${smallInput} w-12`} />
                  <span className="text-[10px] text-gray-500 w-8 text-right">{m.enabled ? `${Math.round((m.weight / totalWeight) * 100)}%` : ''}</span>
                </div>
                {m.enabled && (
                  <div className="pl-5 mt-1 space-y-1">
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500" title={cal.detail}>
                      <Pill tone={SOURCE_LABEL[cal.source].tone}>{SOURCE_LABEL[cal.source].label}</Pill>
                      base p50 {fmtMs(cal.p50Ms)} · p95 {fmtMs(cal.p95Ms)}
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[10px] text-gray-500">
                      <label className="flex items-center gap-1">SLO p95
                        <input type="number" min={0} placeholder="ms" value={m.p95TargetMs ?? ''} disabled={disabled}
                          onChange={e => setEntry(m.name, { p95TargetMs: optional(e.target.value) })} className={`${smallInput} w-full`} />
                      </label>
                      <label className="flex items-center gap-1">err
                        <input type="number" min={0} step={0.1} placeholder="%" value={m.errorBudgetPct ?? ''} disabled={disabled}
                          onChange={e => setEntry(m.name, { errorBudgetPct: optional(e.target.value) })} className={`${smallInput} w-full`} />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function LibButton({ icon: Icon, children, onClick, disabled, title }: { icon: typeof Save; children: string; onClick: () => void; disabled: boolean; title: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed">
      <Icon className="w-3 h-3" />{children}
    </button>
  );
}

// Miniature of the VU curve the chosen pattern will produce
function PatternPreview({ scenario }: { scenario: Scenario }) {
  const { pattern, virtualUsers, durationSec, rampUpSec } = scenario;
  const path = useMemo(() => {
    const steps = 60;
    const d = Math.max(1, durationSec);
    const points = Array.from({ length: steps + 1 }, (_, i) => vusAt({ pattern, virtualUsers, durationSec: d, rampUpSec }, 1 + Math.round((i / steps) * (d - 1))));
    const max = Math.max(1, virtualUsers);
    return points.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / steps) * 100).toFixed(2)},${(31 - (v / max) * 28).toFixed(2)}`).join(' ');
  }, [pattern, virtualUsers, durationSec, rampUpSec]);
  return (
    <svg viewBox="0 0 100 32" className="w-full h-10 bg-gray-950 rounded border border-gray-700" preserveAspectRatio="none">
      <path d={`${path} L100,32 L0,32 Z`} fill="#3b82f6" fillOpacity={0.2} />
      <path d={path} fill="none" stroke="#3b82f6" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
