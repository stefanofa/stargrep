import { createFileRoute } from "@tanstack/react-router";
import { starsRoute } from "../lib/stars-route.ts";

// Any login's stars at /@login, the only address for a login named like a stargrep path.
export const Route = createFileRoute("/@{$login}")({ ...starsRoute });
