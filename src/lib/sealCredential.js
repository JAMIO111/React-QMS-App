/**
 * Seal a database sign-in so that only one connector agent can open it (docs/connector-agent-plan.md AG-D4). Runs in the browser with WebCrypto:
 * a one-off ECDH P-256 key agrees a secret with the agent's sealing key, HKDF-SHA256 (no salt, info "fortress-agent-credential-v1") turns it
 * into an AES-256-GCM key, and the sign-in is encrypted with the connection id as additional data, so it cannot be moved to another connection.
 * Fortress only ever carries the result; the agent opens it with its private key (connector-agent SealedBox) and keeps it there.
 * The contract vector connector-agent/contract/sealed-credential.json was made the same way.
 */
const INFO = new TextEncoder().encode("fortress-agent-credential-v1");

const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * @param {string} sealingKey the agent's sealing public key (SPKI, base64), from the connection's `agent.sealingKey`
 * @param {string} connectionId
 * @param {{ username: string, password: string }} signIn
 * @returns {Promise<{ epk: string, iv: string, ct: string }>}
 */
export async function sealCredential(sealingKey, connectionId, { username, password }) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser cannot seal the password (WebCrypto is not available). Use a current browser over https.");
  const agentKey = await subtle.importKey("spki", fromBase64(sealingKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const mine = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "ECDH", public: agentKey }, mine.privateKey, 256);
  const hkdf = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: INFO }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ username, password }));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(connectionId) }, key, plain);
  plain.fill(0);
  return { epk: toBase64(await subtle.exportKey("spki", mine.publicKey)), iv: toBase64(iv), ct: toBase64(ct) };
}
