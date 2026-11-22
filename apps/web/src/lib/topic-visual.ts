import type { RepoVisual } from "@stargrep/ui";
import type { TopicCount } from "./rpc.ts";

// The icon slot's fill for a topic: its logo or its own repo's icon, else two letters, the initials of its first two
// words or its first two letters, as machine-learning gives ml.
export const topicVisual = ({ topic, icon }: Pick<TopicCount, "topic" | "icon">): RepoVisual => {
  const words = topic.split(/[^a-z0-9]+/).filter((word) => word !== "");
  const letters = (
    words.length > 1 ? `${words[0]?.[0]}${words[1]?.[0]}` : (words[0] ?? topic).slice(0, 2)
  ).toLowerCase();
  return icon === null ? { kind: "monogram", letters } : { kind: "icon", ...icon, letters };
};
