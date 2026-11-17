import { describe, expect, it } from "vitest";
import { repairedEmailLink } from "./emailLinkRepair";

describe("repairedEmailLink", () => {
  it("sends a link built on an address without '?' to the confirm page", () => {
    expect(repairedEmailLink("/accept-invite&token_hash=abc&type=magiclink")).toBe(
      "/auth/confirm?token_hash=abc&type=magiclink&next=%2Faccept-invite",
    );
    expect(repairedEmailLink("/set-password&token_hash=x&type=invite", "?mode=invite")).toBe(
      "/auth/confirm?token_hash=x&type=invite&next=%2Fset-password%3Fmode%3Dinvite",
    );
  });
  it("keeps the next of a confirm-page address", () => {
    expect(repairedEmailLink("/auth/confirm&token_hash=x&type=recovery", "?next=%2Fset-password")).toBe(
      "/auth/confirm?token_hash=x&type=recovery&next=%2Fset-password",
    );
  });
  it("leaves ordinary addresses alone", () => {
    expect(repairedEmailLink("/Non-Conformance/Register")).toBeNull();
    expect(repairedEmailLink("/a&b=c")).toBeNull();
  });
});
