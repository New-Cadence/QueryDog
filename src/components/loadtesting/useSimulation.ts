import { useCallback, useEffect, useRef, useState } from 'react';
import { SimulatedRun, measureStep } from './engine';
import type { CapacitySettings, CapacityStep, QueryTick, RunQuery } from './engine';
import type { QueryResult, RunStatus, RunSummary, Scenario, TickPoint } from './model';

// ==================== Test run ====================

export interface RunView {
  scenario: Scenario;
  t: number;
  series: TickPoint[];
  byQuery: QueryTick[][];
  results: QueryResult[];
  totals: ReturnType<SimulatedRun['totals']>;
}

// State machine: idle -> running -> finished (completed or stopped) -> running ...
// The interval owns its SimulatedRun via closure, so a restarted run can never
// be fed by a stale timer, and finish() is a no-op once the timer is cleared.
export function useLoadRun(onFinish: (summary: RunSummary) => void) {
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<RunView | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const runRef = useRef<SimulatedRun | null>(null);
  const timerRef = useRef<number | null>(null);
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onFinishRef.current = onFinish; });

  const finish = useCallback((status: RunStatus) => {
    const run = runRef.current;
    if (timerRef.current === null || !run) return;
    clearInterval(timerRef.current);
    timerRef.current = null;
    setRunning(false);
    if (run.t === 0) return; // stopped before the first second: nothing to record
    const s = run.summary(status);
    setSummary(s);
    onFinishRef.current(s);
  }, []);

  const start = useCallback((scenario: Scenario, queries: RunQuery[]) => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    const run = new SimulatedRun(structuredClone(scenario), queries);
    const publish = () => setView({
      scenario: run.scenario, t: run.t, series: [...run.series], byQuery: [...run.byQuery], results: run.results(), totals: run.totals(),
    });
    runRef.current = run;
    publish();
    setSummary(null);
    setRunning(true);
    timerRef.current = window.setInterval(() => {
      run.tick();
      publish();
      if (run.done) finish('completed');
    }, 1000);
  }, [finish]);

  const stop = useCallback(() => finish('stopped'), [finish]);

  useEffect(() => () => { if (timerRef.current !== null) clearInterval(timerRef.current); }, []);

  return { running, view, summary, start, stop };
}

// ==================== Capacity finder ====================

export interface CapacityOutcome {
  // Highest step that met every threshold (null if the first step already breached)
  sustainable: CapacityStep | null;
  // First step that breached (null if maxVus was reached without breaching)
  breaking: CapacityStep | null;
}

// Steps VUs up (one step per 300ms of wall time; each step simulates stepSec seconds)
// until a threshold or SLO is breached or maxVus is reached.
export function useCapacityFinder() {
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<CapacityStep[]>([]);
  const [outcome, setOutcome] = useState<CapacityOutcome | null>(null);
  const timerRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = null;
    setRunning(false);
  }, []);

  const start = useCallback((scenario: Scenario, queries: RunQuery[], settings: CapacitySettings) => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    const snapshot = structuredClone(scenario);
    const done: CapacityStep[] = [];
    let vus = Math.max(1, settings.startVus);
    setSteps([]);
    setOutcome(null);
    setRunning(true);
    timerRef.current = window.setInterval(() => {
      const step = measureStep(snapshot, queries, vus, Math.max(1, settings.stepSec));
      done.push(step);
      setSteps([...done]);
      const next = vus + Math.max(1, settings.stepVus);
      if (step.breaches.length || next > settings.maxVus) {
        const passing = done.filter(s => !s.breaches.length);
        setOutcome({ sustainable: passing[passing.length - 1] ?? null, breaking: step.breaches.length ? step : null });
        stop();
      }
      vus = next;
    }, 300);
  }, [stop]);

  useEffect(() => () => { if (timerRef.current !== null) clearInterval(timerRef.current); }, []);

  return { running, steps, outcome, start, stop };
}
