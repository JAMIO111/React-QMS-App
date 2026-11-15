/** Acting as a connector agent in the e2e tests: signed requests, registration, sealing, and batches of rows (AG1–AG3). */
import { INestApplication } from '@nestjs/common';
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { canonicalString, REGISTRATION_SUBJECT } from '../src/integrations/agents/agent-signature';

export interface TestAgent { id: string; signing: { spki: string; privateKey: KeyObject }; sealing: { spki: string; privateKey: KeyObject } }

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
};

export function agentClient(app: () => INestApplication) {
  const api = () => request(app().getHttpServer());
  const headers = (agentId: string, key: KeyObject, path: string, raw: Buffer) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString('hex');
    const signature = sign('sha256', Buffer.from(canonicalString({ method: 'POST', path, body: raw, timestamp, nonce, agentId })), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
    return { 'X-Agent-Timestamp': timestamp, 'X-Agent-Nonce': nonce, 'X-Agent-Signature': signature };
  };
  const signed = (agent: TestAgent, path: string, body: unknown = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    return api().post(path).set({ 'Content-Type': 'application/json', 'X-Agent-Id': agent.id, ...headers(agent.id, agent.signing.privateKey, path, raw) }).send(raw.toString('utf8'));
  };
  /** One batch as the agent sends it: gzip of {"seq","lastKey","rows"}, the checksum of the JSON inside in a header, the gzip bytes signed. */
  const batch = (agent: TestAgent, jobId: string, body: { seq: number; lastKey: string | null; rows: unknown[]; changedUpTo?: string }, opts: { checksum?: string; gzip?: Buffer } = {}) => {
    const json = Buffer.from(JSON.stringify(body));
    const gz = opts.gzip ?? gzipSync(json);
    const path = `/api/v1/integrations/agent/jobs/${jobId}/batches`;
    return api().post(path).set({
      'Content-Type': 'application/gzip', 'X-Agent-Id': agent.id, 'X-Batch-Checksum': opts.checksum ?? createHash('sha256').update(json).digest('hex'),
      ...headers(agent.id, agent.signing.privateKey, path, gz),
    }).send(gz);
  };
  const register = async (auth: Record<string, string>, name: string): Promise<TestAgent> => {
    const reg = await api().post('/api/v1/integrations/agent-registrations').set(auth).send({ name }).expect(201);
    const keys = { signing: pair(), sealing: pair() };
    const path = '/api/v1/integrations/agent/register';
    const raw = Buffer.from(JSON.stringify({ token: reg.body.token, signingKey: keys.signing.spki, sealingKey: keys.sealing.spki, version: '0.3.0', os: 'Windows Server 2022', machine: 'ERP01' }));
    const res = await api().post(path).set({ 'Content-Type': 'application/json', ...headers(REGISTRATION_SUBJECT, keys.signing.privateKey, path, raw) }).send(raw.toString('utf8'));
    if (res.status !== 201) throw new Error(`register: ${res.status} ${JSON.stringify(res.body)}`);
    return { id: res.body.agentId, ...keys };
  };
  /** The agent takes its next job and acks it. */
  const take = async (agent: TestAgent) => {
    const next = await signed(agent, '/api/v1/integrations/agent/jobs/next').expect(200);
    await signed(agent, `/api/v1/integrations/agent/jobs/${next.body.id}/ack`).expect(200);
    return next.body as { id: string; kind: string; spec: Record<string, any>; resume?: { nextSeq: number; afterKey?: string; rows: number } };
  };
  const does = async (agent: TestAgent, report: 'complete' | 'fail', payload: unknown) => {
    const job = await take(agent);
    await signed(agent, `/api/v1/integrations/agent/jobs/${job.id}/${report}`, payload).expect(200);
    return job;
  };
  return { signed, batch, register, take, does };
}

/** Seal as the browser does: ephemeral ECDH P-256 → HKDF-SHA256 (fortress-agent-credential-v1) → AES-256-GCM, the connection id as AAD. */
export function seal(sealingSpki: string, connectionId: string, plaintext: string) {
  const eph = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const secret = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: Buffer.from(sealingSpki, 'base64'), format: 'der', type: 'spki' }) });
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from('fortress-agent-credential-v1'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(connectionId));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { epk: eph.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}
