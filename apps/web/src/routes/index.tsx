import { createFileRoute } from "@tanstack/react-router";
import { starsRoute } from "../lib/stars-route.ts";

export const Route = createFileRoute("/")({ ...starsRoute });
