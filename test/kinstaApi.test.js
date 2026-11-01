'use strict';

/** The Kinsta API client against a fake fetch that answers with the response shapes in Kinsta's OpenAPI spec (1.116). */

const test = require('node:test');
const assert = require('node:assert/strict');

const { KinstaApi } = require('../lib/main/KinstaApi');

const logger = { info() {}, warn() {}, error() {} };

/** routes: { 'GET /path': (url, init) => [status, body] }. Records every request. */
function fakeFetch(routes) {
	const requests = [];
	const fetchImpl = async (url, init) => {
		const u = new URL(url);
		const key = `${init.method} ${u.pathname.replace(/^\/v2/, '')}`;
		requests.push({ key, url: u, init, body: init.body ? JSON.parse(init.body) : null });
		const route = routes[key];
		const [status, body, headers = {}] = route ? route(u, init) : [404, { message: 'Not found', status: 404 }];
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => body,
			headers: { get: (name) => headers[name.toLowerCase()] || null },
		};
	};
	return { fetchImpl, requests };
}

const ENV = {
	id: 'env-live',
	name: 'live',
	display_name: 'Live',
	is_blocked: false,
	is_premium: false,
	web_root: '/',
	wordpress_version: '6.8.1',
	domains: [
		{ id: 'd1', name: 'shop.example.com', type: 'live', site_id: 's1' },
		{ id: 'd2', name: 'shop.kinsta.cloud', type: 'kinsta', site_id: 's1' },
	],
	primaryDomain: { id: 'd1', name: 'shop.example.com', type: 'live', site_id: 's1' },
	ssh_connection: { ssh_port: '31234', ssh_ip: { external_ip: '34.1.2.3' } },
	container_info: { id: 'c1', php_engine_version: 'php8.3' },
};

test('validates the key, learns its company and lists sites with environments', async () => {
	const { fetchImpl, requests } = fakeFetch({
		'GET /validate': () => [200, { name: 'Local', expires_at: null, company: 'comp-1', status: 'active' }],
		'GET /sites': () => [200, { company: { sites: [{ id: 's1', name: 'shop', display_name: 'Shop', status: 'live', environments: [ENV] }] } }],
	});
	const api = new KinstaApi({ apiKey: 'k-123', fetchImpl, logger });
	assert.deepEqual(await api.validate(), { name: 'Local', expiresAt: null, companyId: 'comp-1' });
	const sites = await api.listSites();
	assert.equal(sites[0].environments[0].ssh_connection.ssh_port, '31234');

	assert.equal(requests[0].init.headers.Authorization, 'Bearer k-123');
	const list = requests[1].url;
	assert.equal(list.searchParams.get('company'), 'comp-1');
	assert.equal(list.searchParams.get('include_environments'), 'true');
});

test('lists sites with a stored company id without validating again', async () => {
	const { fetchImpl, requests } = fakeFetch({
		'GET /sites': () => [200, { company: { sites: [] } }],
	});
	await new KinstaApi({ apiKey: 'k', companyId: 'comp-9', fetchImpl, logger }).listSites();
	assert.deepEqual(requests.map((r) => r.key), ['GET /sites']);
});

test('refuses a revoked key and explains a rejected one', async () => {
	const revoked = fakeFetch({ 'GET /validate': () => [200, { name: 'Old', expires_at: null, company: 'c', status: 'revoked' }] });
	await assert.rejects(new KinstaApi({ apiKey: 'k', fetchImpl: revoked.fetchImpl, logger }).validate(), /revoked.*Create a new one/);

	const rejected = fakeFetch({ 'GET /validate': () => [401, { message: 'No or invalid API key provided to the request', status: 401 }] });
	await assert.rejects(new KinstaApi({ apiKey: 'k', fetchImpl: rejected.fetchImpl, logger }).validate(), (e) => e.status === 401 && /rejected this API key/.test(e.message));
});

test('reads the SSH login from ssh/config, falling back to the nested container fields', async () => {
	const full = fakeFetch({
		'GET /sites/s1/environments/env-live/ssh/config': () => [200, {
			site: { id: 's1', name: 'shop', displayName: 'Shop', usr: 'shop', environment: { id: 'env-live', activeContainer: { id: 'c1', lxdSshPort: '31234', loadBalancer: { id: 'lb', extIP: '34.1.2.3' } } } },
			port: '31234', name: 'shop', host: '34.1.2.3', user: 'shopuser', ssh_command: 'ssh shopuser@34.1.2.3 -p 31234',
		}],
	});
	assert.deepEqual(await new KinstaApi({ apiKey: 'k', fetchImpl: full.fetchImpl, logger }).getSshConfig('s1', 'env-live'), { host: '34.1.2.3', port: 31234, username: 'shopuser' });

	const nested = fakeFetch({
		'GET /sites/s1/environments/env-live/ssh/config': () => [200, {
			site: { usr: 'shop', environment: { activeContainer: { lxdSshPort: '31235', loadBalancer: { extIP: '34.1.2.4' } } } },
		}],
	});
	assert.deepEqual(await new KinstaApi({ apiKey: 'k', fetchImpl: nested.fetchImpl, logger }).getSshConfig('s1', 'env-live'), { host: '34.1.2.4', port: 31235, username: 'shop' });
});

test('reads and enables SSH, and fetches the SFTP password', async () => {
	const { fetchImpl, requests } = fakeFetch({
		'GET /sites/environments/env-live/ssh/get-status': () => [200, { environment: { active_container: { is_ssh_enabled: false } } }],
		'POST /sites/environments/env-live/ssh/set-status': () => [200, { result: null }],
		'GET /sites/environments/env-live/ssh/password': () => [200, { environment: { id: 'env-live', sftp_password: 's3cret' } }],
	});
	const api = new KinstaApi({ apiKey: 'k', fetchImpl, logger });
	assert.equal(await api.getSshEnabled('env-live'), false);
	await api.enableSsh('env-live');
	assert.deepEqual(requests[1].body, { is_enabled: true });
	assert.equal(requests[1].init.headers['Content-Type'], 'application/json');
	assert.equal(await api.getSshPassword('env-live'), 's3cret');
});

test('takes a backup and waits for the operation: running (202), then done (200)', async () => {
	let polls = 0;
	const { fetchImpl, requests } = fakeFetch({
		'POST /sites/environments/env-live/manual-backups': () => [202, { operation_id: 'backups:add-manual-1', message: 'Adding a manual backup to environment in progress', status: 202 }],
		'GET /operations/backups:add-manual-1': () => {
			polls += 1;
			return polls < 3 ? [202, { status: 202, message: 'Operation in progress' }] : [200, { status: 200, message: 'Successfully finished request' }];
		},
	});
	const api = new KinstaApi({ apiKey: 'k', fetchImpl, logger });
	const op = await api.createBackup('env-live', 'Before push');
	assert.deepEqual(requests[0].body, { tag: 'Before push' });
	assert.equal(await api.waitForOperation(op, { intervalMs: 1 }), op);
	assert.equal(polls, 3);
});

test('an operation that fails stops the wait; one Kinsta never shows is given up on', async () => {
	const failing = fakeFetch({
		'GET /operations/op-1': () => [500, { status: 500, message: 'Error occurred while processing your request' }],
	});
	await assert.rejects(new KinstaApi({ apiKey: 'k', fetchImpl: failing.fetchImpl, logger }).waitForOperation('op-1', { intervalMs: 1 }), /Error occurred/);

	const unknown = fakeFetch({});
	assert.equal(await new KinstaApi({ apiKey: 'k', fetchImpl: unknown.fetchImpl, logger }).waitForOperation('op-2', { intervalMs: 1, unknownGraceMs: 5 }), null);
});

test('clears the cache for an environment', async () => {
	const { fetchImpl, requests } = fakeFetch({
		'POST /sites/tools/clear-cache': () => [202, { operation_id: 'cache:clear-1', message: 'Clearing site cache in progress', status: 202 }],
	});
	assert.equal(await new KinstaApi({ apiKey: 'k', fetchImpl, logger }).clearCache('env-live'), 'cache:clear-1');
	assert.deepEqual(requests[0].body, { environment_id: 'env-live' });
});

test('retries after a rate limit', async () => {
	let calls = 0;
	const { fetchImpl } = fakeFetch({
		'GET /validate': () => {
			calls += 1;
			return calls === 1 ? [429, { message: 'Too many requests' }, { 'retry-after': '0.001' }] : [200, { name: 'k', expires_at: null, company: 'c', status: 'active' }];
		},
	});
	assert.equal((await new KinstaApi({ apiKey: 'k', fetchImpl, logger }).validate()).companyId, 'c');
	assert.equal(calls, 2);
});
