export const stackName = "Stargrep";
export const webResourceId = "Web";

export const databases = {
  production: {
    logicalId: "ProjectUsEast",
    name: "stargrep-us-east",
    region: "aws-us-east-1",
    pgVersion: 17,
    historyRetentionSeconds: 21600,
    expiryDays: undefined,
    // Its compute never scales below 1 CU, so the file cache that holds repos stays large. Each deploy that changes the
    // branch resets its endpoint to these, so a limit set only in the Neon console would last until the next migration.
    compute: { minCu: 1, maxCu: 8 },
  },
  previews: {
    logicalId: "ProjectPreviewsUsEast",
    name: "stargrep-previews-us-east",
    region: "aws-us-east-1",
    pgVersion: 17,
    historyRetentionSeconds: 0,
    expiryDays: 14,
    compute: undefined,
  },
} as const;

export const isPreviewStage = (stage: string) => /^pr-\d+$/.test(stage);

export const stageSettings = (stage: string) => {
  const production = stage === "prod";
  return {
    stage,
    production,
    defaultServerToken: production ? ("app" as const) : ("pat" as const),
    database: production ? databases.production : databases.previews,
    placement: { region: "aws:us-east-1" as const },
    retain: production,
    debug: !production,
    // A preview answers with deterministic fakes unless its deploy opts in, so opening one spends no model money. A
    // local stage shares one database with its earlier runs, so it keeps the gateway unless its deploy asks for fakes.
    defaultAiProvider: isPreviewStage(stage) ? ("fake" as const) : ("gateway" as const),
  } as const;
};
export type StageSettings = ReturnType<typeof stageSettings>;
