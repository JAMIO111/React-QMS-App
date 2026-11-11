import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import RouteError from "./RouteError";
import { isChunkLoadError, shouldReloadForChunkError } from "../lib/chunkErrors";

const reloadPage = vi.fn();
vi.mock("../lib/chunkErrors", async (importOriginal) => ({ ...(await importOriginal()), reloadPage: (...a) => reloadPage(...a) }));
vi.mock("./NotFound", () => ({ default: () => <p>PAGE NOT FOUND</p> }));

const renderRoute = (page, at = "/page") => {
  const router = createMemoryRouter(
    [{ path: "/", errorElement: <RouteError />, children: [{ path: "page", Component: page }, { path: "dashboard", element: <p>dashboard</p> }] }],
    { initialEntries: [at] },
  );
  return render(<RouterProvider router={router} />);
};
const Boom = (message) => () => {
  throw new Error(message);
};

beforeEach(() => {
  reloadPage.mockClear();
  sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("RouteError", () => {
  it("shows Page not found only for an address that matches no page", () => {
    renderRoute(() => <p>ok</p>, "/nowhere");
    expect(screen.getByText("PAGE NOT FOUND")).toBeInTheDocument();
  });

  it("says something went wrong, with the message and a reload, for a real error (not a 404)", async () => {
    renderRoute(Boom("Cannot read properties of undefined (reading 'x')"));
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByText(/Cannot read properties of undefined/)).toBeInTheDocument();
    expect(screen.queryByText("PAGE NOT FOUND")).toBeNull();
    expect(reloadPage).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Reload the page" }));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Go to the dashboard" })).toHaveAttribute("href", "/Dashboard");
  });

  it("reloads once by itself when a page file cannot be loaded because the app was updated", () => {
    renderRoute(Boom("Failed to fetch dynamically imported module: https://x.test/assets/Page-3fa9c.js"));
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Updating…");
  });

  it("does not reload again in a loop: the second failure within thirty seconds shows the error with a button", () => {
    sessionStorage.setItem("fortress:chunk-reload", String(Date.now()));
    renderRoute(Boom("Importing a module script failed."));
    expect(reloadPage).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("A new version is available");
    expect(screen.getByRole("button", { name: "Reload the page" })).toBeInTheDocument();
  });
});

describe("chunk errors", () => {
  it("recognises the wording of every browser, and nothing else", () => {
    for (const m of [
      "Failed to fetch dynamically imported module: https://a/b.js",
      "error loading dynamically imported module: https://a/b.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/x.css",
      "Loading chunk 12 failed.",
    ])
      expect(isChunkLoadError(new Error(m))).toBe(true);
    expect(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it("allows one reload in thirty seconds, then another after that", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    expect(shouldReloadForChunkError(1_000_000, storage)).toBe(true);
    expect(shouldReloadForChunkError(1_010_000, storage)).toBe(false);
    expect(shouldReloadForChunkError(1_031_000, storage)).toBe(true);
  });

  it("never reloads when storage is unavailable (it could not stop a loop)", () => {
    expect(shouldReloadForChunkError(1, null)).toBe(false);
    expect(shouldReloadForChunkError(1, { getItem: () => { throw new Error("blocked"); }, setItem: () => {} })).toBe(false);
  });
});
