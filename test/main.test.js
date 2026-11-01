'use strict';

/**
 * Loads the add-on's main entry with Local's main-process API mocked, then drives its IPC handlers. The Kinsta API is
 * a fake global fetch; SSH is stubbed at SyncService.transportFor (a fake transport) and at
 * SyncService.discoverRemote / pull.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IPC } = require('../lib/constants');
const { SyncService } = require('../lib/main/SyncService');
const { TransportError } = require('../lib/main/transport');

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-main-test-'));
test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));

const calls = [];
const handlers = {};
const existingSites = {
	a1: { id: 'a1', name: 'Shop Copy', domain: 'shop-copy.local', path: '~/Local Sites/shop-copy' },
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const cradle = {
	localLogger: { child: () => logger },
	siteData: { getSites: () => existingSites, getSite: (id) => existingSites[id] },
	siteDatabase: {},
	siteProcessManager: {},
	wpCli: {},
	addSite: {
		addSite: async (args) => {
			calls.push(['addSite', args]);
			const site = { id: 'new1', name: args.newSiteInfo.siteName, domain: args.newSiteInfo.siteDomain };
			existingSites.new1 = site;
			return site;
		},
	},
};
const localMain = {
	getServiceContainer: () => ({ cradle }),
	addIpcAsyncListener: (channel, fn) => { handlers[channel] = fn; },
	sendIPCEvent: (...args) => calls.push(['ipc', ...args]),
	UserData: { get: () => ({}) },
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (request === '@getflywheel/local/main') return localMain;
	return originalLoad.call(this, request, ...rest);
};

const REMOTE = { remotePath: '/www/shop_123/public', privateDir: '/www/shop_123/private/.kinsta-connect', wp: 'wp', hasWpCli: true, hasRsync: true, hasPhp: true, nested: [] };

const env = (id, name, extra = {}) => ({
	id,
	name,
	display_name: name === 'live' ? 'Live' : 'Staging',
	is_blocked: false,
	web_root: '/',
	wordpress_version: '6.8.1',
	domains: [{ id: `${id}-d1`, name: name === 'live' ? 'shop.example.com' : `stg-shop-${name}.kinsta.cloud`, type: 'live' }, { id: `${id}-d2`, name: 'shop.kinsta.cloud', type: 'kinsta' }],
	primaryDomain: { id: `${id}-d1`, name: name === 'live' ? 'shop.example.com' : `stg-shop-${name}.kinsta.cloud`, type: 'live' },
	ssh_connection: { ssh_port: '31234', ssh_ip: { external_ip: '34.1.2.3' } },
	...extra,
});
const SITES = [
	{ id: 's2', name: 'blog', display_name: 'Blog', environments: [env('env-blog', 'live', { is_blocked: true })] },
	{ id: 's1', name: 'shop', display_name: 'Shop', environments: [env('env-stg', 'staging'), env('env-live', 'live')] },
];

/** Fake Kinsta API. `api.sshEnabled` and `api.passwordLogin` steer it; every request is recorded in `calls`. */
const api = { sshEnabled: true };
globalThis.fetch = async (url, init) => {
	const u = new URL(url);
	const key = `${init.method} ${u.pathname.replace(/^\/v2/, '')}`;
	calls.push(['api', key, init.body ? JSON.parse(init.body) : null]);
	const routes = {
		'GET /validate': () => (init.headers.Authorization === 'Bearer good-key'
			? [200, { name: 'Local dev', expires_at: '2027-01-01T00:00:00.000Z', company: 'comp-1', status: 'active' }]
			: [401, { message: 'No or invalid API key provided to the request', status: 401 }]),
		'GET /sites': () => [200, { company: { sites: SITES } }],
		'GET /sites/s1/environments': () => [200, { site: { environments: SITES[1].environments } }],
		'GET /sites/environments/env-live/ssh/get-status': () => [200, { environment: { active_container: { is_ssh_enabled: api.sshEnabled } } }],
		'POST /sites/environments/env-live/ssh/set-status': () => [200, { result: null }],
		'GET /sites/s1/environments/env-live/ssh/config': () => [200, { port: '31234', name: 'shop', host: '34.1.2.3', user: 'shopuser', ssh_command: '' }],
		'GET /sites/environments/env-live/ssh/password': () => [200, { environment: { id: 'env-live', sftp_password: 'from-api' } }],
	};
	const [status, body] = routes[key] ? routes[key]() : [404, { message: 'Not found', status: 404 }];
	return { status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: () => null } };
};

/** How SSH logins go: (transport) -> true to accept. By default the key is refused and the API password accepted. */
let acceptLogin;
const defaultLogin = (transport) => Boolean(transport.password);

SyncService.prototype.transportFor = function transportFor(link) {
	return {
		username: link.username,
		host: link.host,
		port: link.port,
		password: link.authType === 'password' ? link.password : null,
		close: async () => {},
		exec: async () => ({ code: 0, stdout: '', stderr: '' }),
	};
};
let discoverBehaviour = async () => REMOTE;
SyncService.prototype.discoverRemote = async function discoverRemote(transport, hints) {
	calls.push(['discover', transport.username, transport.host, transport.port, transport.password, hints]);
	if (!acceptLogin(transport)) {
		throw new TransportError(`Kinsta refused the ${transport.password ? 'password' : 'SSH key'} for ${transport.username}@${transport.host}`, 255, 'Permission denied (publickey,password).');
	}
	return discoverBehaviour(transport, hints);
};
SyncService.prototype.pull = async function pull(siteId, options) {
	calls.push(['pull', siteId, options]);
	return { ok: true };
};

const fakeSafeStorage = {
	isEncryptionAvailable: () => true,
	encryptString: (v) => Buffer.from(v),
	decryptString: (b) => b.toString(),
};
const addonMain = require('../lib/main');
addonMain({ electron: { safeStorage: fakeSafeStorage }, environment: { userDataPath } });

const waitFor = async (predicate, timeoutMs = 2000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('timed out');
};
const names = () => calls.map((c) => c[0]);
const apiCalls = () => calls.filter((c) => c[0] === 'api').map((c) => c[1]);
const settingsFile = () => fs.readFileSync(path.join(userDataPath, 'kinsta-connect', 'settings.json'), 'utf8');
const reset = () => {
	calls.length = 0;
	api.sshEnabled = true;
	acceptLogin = defaultLogin;
	discoverBehaviour = async () => REMOTE;
};

test('suggests a non-clashing domain and folder from Local defaults', () => {
	assert.deepEqual(handlers[IPC.NEW_SITE_LOCATION]('Shop Copy!'), { domain: 'shop-copy-2.local', sitePath: path.join('~/Local Sites/', 'shop-copy-2') });
	assert.equal(handlers[IPC.NEW_SITE_LOCATION]('Brand New').domain, 'brand-new.local');
});

test('a rejected API key is reported and nothing is stored', async () => {
	reset();
	await assert.rejects(handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'bad-key' }), /rejected this API key/);
	assert.equal((await handlers[IPC.GET_STATE]()).account, null);
});

test('connecting validates the key, learns the company and keeps the key out of the renderer', async () => {
	reset();
	const state = await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: ' good-​key\n' });
	assert.deepEqual(state.account, { companyId: 'comp-1', keyName: 'Local dev', expiresAt: '2027-01-01T00:00:00.000Z' });
	assert.ok(!settingsFile().includes('good-key'), 'the key is stored encrypted');
	assert.ok(!JSON.stringify(state).includes('good-key'));
});

test('lists one choice per environment, live first, with the primary domain and the other domains', async () => {
	reset();
	const choices = await handlers[IPC.LIST_SITES]();
	assert.deepEqual(choices.map((c) => [c.siteName, c.envName, c.isBlocked]), [['Blog', 'Live', true], ['Shop', 'Live', false], ['Shop', 'Staging', false]]);
	assert.equal(choices[1].domain, 'shop.example.com');
	assert.deepEqual(choices[1].altDomains, ['shop.kinsta.cloud']);
	const list = calls.find((c) => c[0] === 'api' && c[1] === 'GET /sites');
	assert.ok(list, 'sites are listed for the key\'s company');
});

test('links with Local\'s SSH key when MyKinsta has it, turning SFTP/SSH on first', async () => {
	reset();
	api.sshEnabled = false;
	acceptLogin = (t) => !t.password;
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a1', kinstaSiteId: 's1', envId: 'env-live', siteName: 'Shop', progressId: 'p1' });
	assert.ok(apiCalls().includes('POST /sites/environments/env-live/ssh/set-status'));
	assert.deepEqual(calls.find((c) => c[0] === 'discover').slice(1), ['shopuser', '34.1.2.3', 31234, null, { webRoot: '/' }]);
	assert.equal(state.link.mode, 'account');
	assert.equal(state.link.authType, 'key');
	assert.equal(state.link.label, 'Shop (Live)');
	assert.equal(state.link.isLive, true);
	assert.equal(state.link.domain, 'shop.example.com');
	assert.deepEqual(state.link.altDomains, ['shop.kinsta.cloud']);
	assert.equal(state.link.remotePath, '/www/shop_123/public');
	assert.ok(!apiCalls().includes('GET /sites/environments/env-live/ssh/password'), 'no password is fetched when the key works');

	const progress = calls.filter((c) => c[0] === 'ipc' && c[1] === IPC.LINK_PROGRESS);
	assert.ok(progress.some((c) => c[3] === 'Turning on SFTP/SSH for the environment…'));
	assert.ok(progress.every((c) => c[2] === 'p1'), 'progress goes to the requesting form only');
});

test('falls back to the SFTP/SSH password from the API, and never stores it', async () => {
	reset();
	const state = await handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'a1', kinstaSiteId: 's1', envId: 'env-live', siteName: 'Shop' });
	assert.equal(state.link.authType, 'api-password');
	assert.equal(state.link.hasPassword, false);
	assert.deepEqual(calls.filter((c) => c[0] === 'discover').map((c) => c[4]), [null, 'from-api']);
	assert.ok(!settingsFile().includes('from-api'));

	// Each later connection fetches the password again.
	calls.length = 0;
	await handlers[IPC.TEST_CONNECTION]('a1');
	assert.ok(apiCalls().includes('GET /sites/environments/env-live/ssh/password'));
	assert.equal(calls.find((c) => c[0] === 'discover')[4], 'from-api');
});

test('explains what to change when both the key and the password are refused', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(
		handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', kinstaSiteId: 's1', envId: 'env-live', siteName: 'Shop' }),
		/refused both Local's SSH key and the environment's SFTP\/SSH password.*Shop → Info → SFTP\/SSH.*User settings → SSH keys/,
	);
	assert.equal((await handlers[IPC.GET_STATE]('b2')).link, null);
});

test('an environment Kinsta has blocked is not linked', async () => {
	reset();
	await assert.rejects(handlers[IPC.LINK_ACCOUNT_SITE]({ siteId: 'b2', kinstaSiteId: 's1', envId: 'env-missing' }), /could not be found/);
});

test('a password-from-API link asks to reconnect once the account is disconnected', async () => {
	reset();
	await handlers[IPC.DISCONNECT_ACCOUNT]();
	await assert.rejects(handlers[IPC.TEST_CONNECTION]('a1'), /Connect your Kinsta account again/);
	await handlers[IPC.CONNECT_ACCOUNT]({ apiKey: 'good-key' });
});

test('links with SFTP/SSH details copied from MyKinsta', async () => {
	reset();
	acceptLogin = () => true;
	const state = await handlers[IPC.LINK_MANUAL]({
		siteId: 'm1', host: ' 34.1.2.9 ', port: '30999', username: 'shopuser', authType: 'password', password: 'typed-pw', remotePath: '', domain: 'https://shop.example.com/',
	});
	assert.deepEqual(calls.find((c) => c[0] === 'discover').slice(1), ['shopuser', '34.1.2.9', 30999, 'typed-pw', { remotePath: null }]);
	assert.equal(state.link.mode, 'manual');
	assert.equal(state.link.label, 'shop.example.com');
	assert.equal(state.link.hasPassword, true);
	assert.ok(!settingsFile().includes('typed-pw'), 'a typed password is stored encrypted');
});

test('pull to new site verifies the connection, creates the site, links it, then pulls', async () => {
	reset();
	const res = await handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Shop Copy',
		source: { kind: 'account', kinstaSiteId: 's1', envId: 'env-live', siteName: 'Shop' },
	});
	assert.equal(res.domain, 'shop-copy-2.local');
	assert.ok(names().includes('discover') && names().indexOf('discover') < names().indexOf('addSite'), 'connection is checked before anything is created');

	await waitFor(() => names().includes('pull'));
	const addSite = calls.find((c) => c[0] === 'addSite')[1];
	assert.deepEqual(addSite.newSiteInfo, {
		siteName: 'Shop Copy',
		siteDomain: 'shop-copy-2.local',
		sitePath: path.join('~/Local Sites/', 'shop-copy-2'),
		environment: 'flywheel',
		multiSite: '',
	});
	assert.equal(addSite.installWP, true);
	assert.equal(addSite.goToSite, true);
	assert.equal(addSite.wpCredentials.adminUsername, 'admin');
	assert.ok(addSite.wpCredentials.adminPassword.length >= 16);

	assert.deepEqual(calls.find((c) => c[0] === 'pull').slice(1), ['new1', { deleteLocal: true, backupLocal: false }]);
	assert.ok(names().indexOf('addSite') < names().indexOf('pull'));

	const state = await handlers[IPC.GET_STATE]('new1');
	assert.equal(state.link.label, 'Shop (Live)');
	assert.equal(state.link.authType, 'api-password');
});

test('pull to new site creates nothing when the connection fails', async () => {
	reset();
	acceptLogin = () => false;
	await assert.rejects(handlers[IPC.PULL_NEW_SITE]({
		siteName: 'Broken',
		source: { kind: 'manual', host: '34.1.2.3', port: '31234', username: 'u', authType: 'password', password: 'nope' },
	}), /refused the password/);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(!names().includes('addSite'));
});
