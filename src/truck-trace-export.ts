import type { RouteBlock, TruckTraceReport } from './truck-trace.ts';

type Truck = TruckTraceReport['trucks'][number];
type Event = Truck['events'][number];
type BlockerSummary = Pick<RouteBlock, 'segment'> & Pick<RouteBlock['blocker'], 'kind' | 'id' | 'atStart'>;

function summarizeEvent(event: Event) {
  if (event.kind !== 'decision') return event;

  const { checks, selectedCheck, ...decision } = event;
  const blockers = new Map<string, BlockerSummary>();
  for (const { blockedBy } of checks) {
    if (!blockedBy) continue;
    const { segment, blocker: { kind, id, atStart } } = blockedBy;
    blockers.set(`${segment}:${kind}:${id}:${atStart}`, { segment, kind, id, atStart });
  }
  return {
    ...decision,
    routesChecked: checks.length,
    routesRejected: checks.filter(check => check.score === null).length,
    selectedRoute: selectedCheck === null ? null : checks[selectedCheck],
    routeBlockers: [...blockers.values()],
  };
}

export function serializeTruckTrace(report: TruckTraceReport, full = false) {
  if (full) return JSON.stringify(report);

  const compact = {
    ...report,
    version: 2,
    detail: 'compact' as const,
    trucks: report.trucks.map(truck => ({
      ...truck,
      events: truck.events.map(summarizeEvent),
      lastStop: truck.lastStop && { ...truck.lastStop, preceding: truck.lastStop.preceding.map(summarizeEvent) },
    })),
  };
  return JSON.stringify(compact, function (this: object, _key, value: unknown) {
    if (this === report.tuning || this === report.startingTuning) return value;
    return typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)
      ? Number(value.toFixed(4))
      : value;
  });
}
