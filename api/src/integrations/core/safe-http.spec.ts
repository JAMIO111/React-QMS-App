import { hostAllowed, isPublicAddress, ResolvedAddress, SafeHttpClient, SafeHttpError, SendRequest, urlProblem } from './safe-http';

const ok = (body = '[]', status = 200, headers: Record<string, string> = {}) => async () => ({ status, headers, body: Buffer.from(body) });

/** A client whose DNS answers from a table and whose sender records what it was asked to send (nothing leaves the machine). */
function client(dns: Record<string, string[]>, send = ok()) {
  const sent: SendRequest[] = [];
  const c = new SafeHttpClient({
    resolve: async (host): Promise<ResolvedAddress[]> => {
      if (!(host in dns)) throw new Error('ENOTFOUND');
      return dns[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    send: async (req) => {
      sent.push(req);
      return send();
    },
  });
  return { c, sent };
}

const refused = async (p: Promise<unknown>, kind: SafeHttpError['kind'], message?: RegExp) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SafeHttpError);
  expect((e as SafeHttpError).kind).toBe(kind);
  if (message) expect((e as SafeHttpError).message).toMatch(message);
};

describe('which addresses are public', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.0.170',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:a9fe:a9fe', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::',
    'not an address', '', 'localhost',
  ])('%s is not public', (a) => expect(isPublicAddress(a)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '::ffff:8.8.8.8'])('%s is public', (a) => expect(isPublicAddress(a)).toBe(true));
});

describe('which addresses may be called at all', () => {
  it.each([
    ['http://api.example.com/x', /https/],
    ['https://user:pw@api.example.com/x', /user name/],
    ['https://api.example.com:8443/x', /port/],
    ['https://127.0.0.1/x', /host name/],
    ['https://[::1]/x', /host name/],
    ['https://169.254.169.254/latest/meta-data', /host name/],
    ['https://localhost/x', /host name|public/],
    ['https://erp.corp/x', /public/],
    ['https://metadata.google.internal/x', /public/],
    ['https://printer.local/x', /public/],
  ])('%s is refused', (u, m) => expect(urlProblem(new URL(u))).toMatch(m));

  it('accepts a public https host on the standard port', () => {
    expect(urlProblem(new URL('https://erp.example.com/api/v1'))).toBeNull();
    expect(urlProblem(new URL('https://erp.example.com:443/api'))).toBeNull();
  });

  it('applies the organisation allow-list to the host and its sub-domains', () => {
    expect(hostAllowed('api.example.com', [])).toBe(true);
    expect(hostAllowed('api.example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('evil-example.com', ['example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.net', ['example.com'])).toBe(false);
  });
});

describe('a guarded request', () => {
  it('connects to the address it checked, sends only allowed headers and never Host', async () => {
    const { c, sent } = client({ 'api.example.com': ['93.184.216.34'] });
    const res = await c.get(new URL('https://api.example.com/v1/parts?page=1'), { headers: { Accept: 'application/json', 'X-Api-Key': 'k' } });
    expect(res.status).toBe(200);
    expect(sent[0].address).toEqual({ address: '93.184.216.34', family: 4 });
    expect(sent[0].headers).toEqual({ Accept: 'application/json', 'X-Api-Key': 'k' });
    for (const h of ['Host', 'host', 'Connection', 'Transfer-Encoding', 'Cookie', 'Proxy-Authorization', 'X-Forwarded-For']) {
      await refused(c.get(new URL('https://api.example.com/'), { headers: { [h]: 'x' } }), 'blocked', /cannot be set/);
    }
    await refused(c.get(new URL('https://api.example.com/'), { headers: { 'X-Api-Key': 'a\r\nHost: evil' } }), 'blocked', /line break/);
  });

  it('refuses loopback, private ranges and the metadata address behind a public-looking name, before sending anything', async () => {
    const { c, sent } = client({
      'loop.example.com': ['127.0.0.1'],
      'private.example.com': ['10.0.0.5'],
      'meta.example.com': ['169.254.169.254'],
      'v6.example.com': ['::1'],
      'mapped.example.com': ['::ffff:192.168.0.10'],
      // A name that answers with one public and one private address is refused whichever would be used.
      'mixed.example.com': ['93.184.216.34', '10.1.1.1'],
    });
    for (const h of ['loop', 'private', 'meta', 'v6', 'mapped', 'mixed']) await refused(c.get(new URL(`https://${h}.example.com/`)), 'blocked', /private or reserved/);
    expect(sent).toHaveLength(0);
  });

  it('refuses IP literals and hosts outside the allow-list without looking them up', async () => {
    const { c, sent } = client({ 'api.other.com': ['93.184.216.34'] });
    await refused(c.get(new URL('https://10.0.0.1/')), 'blocked');
    await refused(c.get(new URL('https://api.other.com/'), { allowedHosts: ['example.com'] }), 'blocked', /does not allow connections to api\.other\.com/);
    expect(sent).toHaveLength(0);
  });

  it('never follows a redirect, even to a public address', async () => {
    const { c } = client({ 'api.example.com': ['93.184.216.34'] }, ok('', 302, { location: 'https://169.254.169.254/latest/meta-data' }));
    await refused(c.get(new URL('https://api.example.com/')), 'redirect', /never followed/);
  });

  it('bounds the answer and the time allowed', async () => {
    const { c, sent } = client({ 'api.example.com': ['93.184.216.34'] }, ok('x'.repeat(2048)));
    await refused(c.get(new URL('https://api.example.com/'), { maxBytes: 1024 }), 'too_large');
    await c.get(new URL('https://api.example.com/'), { timeoutMs: 999_999, maxBytes: 999_999_999 }).catch(() => null);
    expect(sent[1].timeoutMs).toBe(60_000);
    expect(sent[1].maxBytes).toBe(10 * 1024 * 1024);
  });

  it('says when a name cannot be found', async () => {
    const { c } = client({});
    await refused(c.get(new URL('https://nowhere.example.com/')), 'network', /could not be found/);
  });

  it('the default client refuses a private target without connecting', async () => {
    // Real resolver: localhost-style names are refused by the address rules, IP literals by the URL rules.
    const c = new SafeHttpClient();
    await refused(c.get(new URL('https://127.0.0.1/')), 'blocked');
    await refused(c.get(new URL('https://169.254.169.254/latest/meta-data')), 'blocked');
    await refused(c.get(new URL('https://localhost/')), 'blocked');
  });
});
