export const stackName = "Stargrep";
export const webResourceId = "Web";

export const stageSettings = (stage: string) => {
  const production = stage === "prod";
  return {
    stage,
    production,
    defaultServerToken: production ? ("app" as const) : ("pat" as const),
    database: {
      logicalId: production ? "ProjectUsEast" : "ProjectPreviewsUsEast",
      name: production ? "stargrep-us-east" : "stargrep-previews-us-east",
      region: "aws-us-east-1",
      pgVersion: 17 as const,
      historyRetentionSeconds: production ? 21600 : 0,
      expiryDays: production ? undefined : 14,
    },
    placement: { region: "aws:us-east-1" as const },
    retain: production,
    debug: !production,
  } as const;
};
export type StageSettings = ReturnType<typeof stageSettings>;
