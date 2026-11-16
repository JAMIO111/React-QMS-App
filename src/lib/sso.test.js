import { describe, expect, it, vi } from "vitest";

vi.mock("../supabase-client", () => ({ default: { auth: { signInWithSSO: vi.fn() } } }));

import { domainOf, isCompanyAccount, ssoErrorWords } from "./sso";

describe("single sign-on helpers", () => {
  it("takes the domain of a work email", () => {
    expect(domainOf(" Ada@Acme.COM ")).toBe("acme.com");
    expect(domainOf("ada@uk.acme.co.uk")).toBe("uk.acme.co.uk");
    expect(domainOf("not an email")).toBeNull();
    expect(domainOf("ada@localhost")).toBeNull();
    expect(domainOf(undefined)).toBeNull();
  });

  it("knows an account made by a company sign-in", () => {
    expect(isCompanyAccount({ identities: [{ provider: "sso:aaaa" }] })).toBe(true);
    expect(isCompanyAccount({ identities: [{ provider: "email" }] })).toBe(false);
    expect(isCompanyAccount(null)).toBe(false);
  });

  it("says plainly when a company has no single sign-on", () => {
    expect(ssoErrorWords({ code: "sso_provider_not_found" })).toMatch(/has not set up single sign-on/);
    expect(ssoErrorWords({ message: "No SSO provider assigned for this domain" })).toMatch(/has not set up/);
    expect(ssoErrorWords({ status: 429 })).toMatch(/Too many attempts/);
    expect(ssoErrorWords({})).toMatch(/could not be started/);
  });
});
