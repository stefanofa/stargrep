export interface Row {
  readonly stage: "embedding" | "summary";
  readonly model: string;
  readonly recall: number;
  readonly medianMillis: number;
  readonly cost: number;
  readonly failures: number;
}

export const embeddingLatencyBudgetMillis = 600;

const byRecall = (left: Row, right: Row) => right.recall - left.recall;

export const rankEmbeddings = (rows: ReadonlyArray<Row>) => ({
  ranked: rows.filter((row) => row.medianMillis <= embeddingLatencyBudgetMillis).sort(byRecall),
  overBudget: rows.filter((row) => row.medianMillis > embeddingLatencyBudgetMillis),
});

export const rankSummaries = (rows: ReadonlyArray<Row>, queryCount: number) => {
  const top = Math.max(...rows.map((row) => row.recall));
  const tied = (row: Row) => top - row.recall <= 1 / queryCount;
  return [...rows].sort((left, right) =>
    tied(left) && tied(right) ? left.cost - right.cost || byRecall(left, right) : byRecall(left, right),
  );
};
