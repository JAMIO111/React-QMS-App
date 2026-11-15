// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import { sealCredential } from "./sealCredential";

/** Open as the agent does (connector-agent SealedBox.Open), with Node's crypto. */
function open(privateKey, connectionId, { epk, iv, ct }) {
  const secret = diffieHellman({ privateKey, publicKey: createPublicKey({ key: Buffer.from(epk, "base64"), format: "der", type: "spki" }) });
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from("fortress-agent-credential-v1"), 32));
  const all = Buffer.from(ct, "base64");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(connectionId));
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()]).toString("utf8");
}

describe("sealing a database password for the agent", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sealingKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const connectionId = "5f0c2b8e-3a51-4d6c-9e2f-7b8a1c4d0e93";

  it("only the agent's private key opens it, and only for that connection", async () => {
    const sealed = await sealCredential(sealingKey, connectionId, { username: "reader", password: 'Pa55; "x" £' });
    expect(Object.keys(sealed).sort()).toEqual(["ct", "epk", "iv"]);
    expect(Buffer.from(sealed.iv, "base64")).toHaveLength(12);
    expect(JSON.parse(open(privateKey, connectionId, sealed))).toEqual({ username: "reader", password: 'Pa55; "x" £' });
    expect(() => open(privateKey, "another-connection", sealed)).toThrow();
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(() => open(other, connectionId, sealed)).toThrow();
    expect(JSON.stringify(sealed)).not.toContain("Pa55");
  });

  it("each seal is different (a fresh key and nonce every time)", async () => {
    const a = await sealCredential(sealingKey, connectionId, { username: "u", password: "p" });
    const b = await sealCredential(sealingKey, connectionId, { username: "u", password: "p" });
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
  });

  it("agrees with the shared contract vector the agent's tests open", async () => {
    const v = JSON.parse(readFileSync(new URL("../../connector-agent/contract/sealed-credential.json", import.meta.url), "utf8"));
    const key = createPrivateKey({ key: Buffer.from(v.sealingPrivateKey, "base64"), format: "der", type: "pkcs8" });
    expect(open(key, v.connectionId, v.sealed)).toBe(v.plaintext);
    const mine = await sealCredential(v.sealingPublicKey, v.connectionId, JSON.parse(v.plaintext));
    expect(JSON.parse(open(key, v.connectionId, mine))).toEqual(JSON.parse(v.plaintext));
  });
});
