/**
 * A connector agent for the browser journey (docs/connector-agent-plan.md AG6d): it speaks the agent's real protocol to the REAL API — keys made here,
 * every request signed exactly as the .NET agent signs it (the API's own canonicalString, from api/dist), registration with the token the browser
 * showed — and does the jobs the journey needs: ping, and store_credential, whose sealed password it opens with its own sealing key so the journey
 * can check that what the person typed is what arrived (and that Fortress never saw it). Nothing here is used in production.
 */
const path = require('path');
const crypto = require('crypto');
const { canonicalString, REGISTRATION_SUBJECT } = require(path.resolve(__dirname, '../../api/dist/integrations/agents/agent-signature'));

const pair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
};

/** Open a sealed password as the agent does: ECDH P-256 with the agent's sealing key -> HKDF-SHA256 -> AES-256-GCM, the connection id as AAD. */
function openSealed(privateKey, connectionId, { epk, iv, ct }) {
  const secret = crypto.diffieHellman({ privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(epk, 'base64'), format: 'der', type: 'spki' }) });
  const key = Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from('fortress-agent-credential-v1'), 32));
  const raw = Buffer.from(ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(connectionId));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
}

function fakeAgent(apiUrl, log = () => {}) {
  const keys = { signing: pair(), sealing: pair() };
  const state = { id: null, revoked: false, jobs: [], credentials: new Map(), stopped: false };
  const base = new URL(apiUrl);

  const post = async (relative, body, subject) => {
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/${relative}`, base);
    const raw = Buffer.from(body === undefined ? '' : JSON.stringify(body));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const agentId = subject ?? state.id;
    const signature = crypto
      .sign('sha256', Buffer.from(canonicalString({ method: 'POST', path: url.pathname, body: raw, timestamp, nonce, agentId })), { key: keys.signing.privateKey, dsaEncoding: 'ieee-p1363' })
      .toString('base64');
    const headers = { 'Content-Type': 'application/json', 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature };
    if (!subject) headers['X-Agent-Id'] = state.id;
    const res = await fetch(url, { method: 'POST', headers, body: raw.length ? raw : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const capabilities = { jobs: ['ping', 'store_credential'], adapters: ['postgres'], maxBatchRows: 1000, platform: 'win-x64' };
  const about = { version: '0.1.0', os: 'Microsoft Windows 10.0.20348 (journey)', machine: 'JOURNEY01', capabilities };

  async function register(token) {
    const res = await post('integrations/agent/register', { token, signingKey: keys.signing.spki, sealingKey: keys.sealing.spki, ...about }, REGISTRATION_SUBJECT);
    if (res.status !== 201) throw new Error(`the fake agent could not register: ${res.status} ${JSON.stringify(res.body)}`);
    state.id = res.body.agentId;
    log(`fake agent registered as ${state.id}`);
    return res.body;
  }

  async function doJob(job) {
    await post(`integrations/agent/jobs/${job.id}/ack`);
    state.jobs.push(job);
    if (job.kind === 'ping') {
      return post(`integrations/agent/jobs/${job.id}/complete`, { result: { pong: true, version: about.version, agentTime: new Date().toISOString() } });
    }
    if (job.kind === 'store_credential') {
      try {
        const plain = JSON.parse(openSealed(keys.sealing.privateKey, job.spec.connectionId, job.spec.sealed));
        state.credentials.set(job.spec.connectionId, plain);
        return post(`integrations/agent/jobs/${job.id}/complete`, { result: { stored: true, username: plain.username } });
      } catch (e) {
        return post(`integrations/agent/jobs/${job.id}/fail`, { kind: 'invalid', message: `The password could not be opened (${e.message})`, transient: false });
      }
    }
    return post(`integrations/agent/jobs/${job.id}/fail`, { kind: 'invalid', message: `The journey's agent does not do "${job.kind}" jobs`, transient: false });
  }

  /** Heartbeat and take jobs every half second until stopped or revoked, as the real agent does while a page is open. */
  async function run() {
    while (!state.stopped && !state.revoked) {
      try {
        const hb = await post('integrations/agent/heartbeat', { ...about, uptimeSeconds: 1 });
        if (hb.status === 401 && hb.body?.code === 'agent_revoked') state.revoked = true;
        else if (hb.body?.revoked) state.revoked = true;
        if (state.revoked) break;
        const next = await post('integrations/agent/jobs/next');
        if (next.status === 200 && next.body?.id) await doJob(next.body);
      } catch (e) {
        log(`fake agent: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    log(`fake agent stopped${state.revoked ? ' (revoked)' : ''}`);
  }

  let loop = null;
  return {
    state,
    register,
    start() { loop = run(); return loop; },
    async stop() { state.stopped = true; await loop; },
  };
}

module.exports = { fakeAgent, openSealed };
