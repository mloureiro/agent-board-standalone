export type PlanCounts = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface PlanReport {
  readonly sourceVersion: string;
  readonly owners: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export const buildPlan = (sourceVersion: string, counts: PlanCounts): PlanReport => ({
  sourceVersion,
  owners: Object.fromEntries(
    [...counts].map(([owner, tables]) => [owner, Object.fromEntries(tables)]),
  ),
});

export function formatPlan(plan: PlanReport): string {
  const lines = [`plan for source ${plan.sourceVersion}`];
  for (const [owner, tables] of Object.entries(plan.owners)) {
    lines.push(`owner ${owner}`);
    for (const [table, count] of Object.entries(tables)) lines.push(`  ${table}: ${count}`);
  }
  return `${lines.join('\n')}\n`;
}
