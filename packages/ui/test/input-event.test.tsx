import { expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { page } from "./dom.ts";

function Query({ label }: { label: string }) {
  const [value, setValue] = useState("terminal");
  return <input aria-label={label} value={value} onChange={(event) => setValue(event.target.value)} />;
}

test("a value changed without a key press survives the next render", () => {
  const view = render(<Query label="query" />);
  const box = page().getByRole<HTMLInputElement>("textbox");
  fireEvent.input(box, { target: { value: "" } });
  view.rerender(<Query label="search" />);
  expect(box.value).toBe("");
});
