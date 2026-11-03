import { afterEach } from "bun:test";
import { cleanup, within } from "@testing-library/react";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

export const page = () => within(document.body);
