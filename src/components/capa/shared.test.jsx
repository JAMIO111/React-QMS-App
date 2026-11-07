import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { StepProgress } from "./shared";

const squares = (c) => [...c.querySelectorAll("[data-filled]")];

describe("StepProgress", () => {
  it("shows nine squares: three red, three amber, three green, the incomplete ones grey", () => {
    const { container } = render(<StepProgress done={5} current="d5" />);
    const s = squares(container);
    expect(s).toHaveLength(9);
    expect(s.slice(0, 3).every((x) => x.className.includes("bg-red-400"))).toBe(true);
    expect(s.slice(3, 5).every((x) => x.className.includes("bg-amber-400"))).toBe(true);
    expect(s.slice(5).every((x) => x.className.includes("bg-border-color") && x.dataset.filled === "false")).toBe(true);
    expect(container).toHaveTextContent("D5 · 5/9");
  });
  it("is all coloured when complete and all grey when nothing is done", () => {
    expect(squares(render(<StepProgress done={9} current={null} />).container).slice(6).every((x) => x.className.includes("bg-green-500"))).toBe(true);
    expect(squares(render(<StepProgress done={0} current="d0" />).container).every((x) => x.dataset.filled === "false")).toBe(true);
  });
});
