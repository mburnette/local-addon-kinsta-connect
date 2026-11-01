'use strict';

/**
 * Mounts the renderer half in jsdom with the real @getflywheel/local-components and React 16 (the version Local
 * ships), stubbing only Electron and Local's renderer API. Catches bad imports/props before Local ever loads it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div><div id="popup-container"></div></body></html>', {
	pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.MutationObserver = dom.window.MutationObserver;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// Remaining DOM constructors (HTMLCollection, NodeList, …) that react-modal and friends expect as globals.
Object.getOwnPropertyNames(dom.window)
	.filter((key) => /^[A-Z]/.test(key) && !(key in global))
	.forEach((key) => { global[key] = dom.window[key]; });

const { IPC } = require('../lib/constants');

let mainState;
let compareResult;
const ipcCalls = [];
const listeners = {};
const stubs = {
	electron: {
		ipcRenderer: {
			on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
			removeListener: (ch, fn) => { listeners[ch] = (listeners[ch] || []).filter((f) => f !== fn); },
		},
		shell: { openExternal() {} },
	},
	'@getflywheel/local/renderer': {
		ipcAsync: async (channel, ...args) => {
			ipcCalls.push([channel, ...args]);
			if (channel === IPC.GET_STATE) return mainState;
			if (channel === IPC.LIST_SITES) {
				return [
					{ kinstaSiteId: 's2', siteName: 'Blog', envId: 'env-blog', envName: 'Live', isLive: true, isBlocked: true, domain: 'blog.example.com', altDomains: [] },
					{ kinstaSiteId: 's1', siteName: 'Shop', envId: 'env-live', envName: 'Live', isLive: true, isBlocked: false, domain: 'shop.example.com', altDomains: ['shop.kinsta.cloud'] },
					{ kinstaSiteId: 's1', siteName: 'Shop', envId: 'env-stg', envName: 'Staging', isLive: false, isBlocked: false, domain: 'stg-shop-staging.kinsta.cloud', altDomains: [] },
				];
			}
			if (channel === IPC.GET_PUBLIC_KEY) return 'ssh-rsa AAAAB3Nza test';
			if (channel === IPC.COMPARE) return compareResult;
			if (channel === IPC.NEW_SITE_LOCATION) return { domain: `${args[0].toLowerCase()}.local`, sitePath: `~/Local Sites/${args[0].toLowerCase()}` };
			if (channel === IPC.PULL_NEW_SITE) return { domain: 'shop.local', sitePath: '~/Local Sites/shop' };
			return null;
		},
		confirm: async () => true,
	},
};
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
	if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
	return originalLoad.call(this, request, ...rest);
};

const React = require('react');
const ReactDOM = require('react-dom');
const { act } = require('react-dom/test-utils');

const registered = { content: {}, filters: {} };
const hooks = {
	addContent: (name, cb) => { (registered.content[name] = registered.content[name] || []).push(cb); },
	addFilter: (name, cb) => { (registered.filters[name] = registered.filters[name] || []).push(cb); },
};
require('../lib/renderer')({ React, ReactRouter: require('react-router-dom'), hooks });

const site = { id: 'site1', name: 'Shop Local', domain: 'shop.local' };

async function mount(element) {
	const root = document.getElementById('root');
	await act(async () => {
		ReactDOM.render(element, root);
	});
	// let ipcAsync promises and effects settle
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	return root;
}

async function click(el) {
	await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}
const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text && b.getAttribute('role') !== 'tab');
const tab = (root, text) => [...root.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === text);

function toolsPanel() {
	const items = registered.filters.siteInfoToolsItem[0]([], { routeChildrenProps: { site, siteStatus: 'running' } });
	assert.equal(items.length, 1);
	assert.equal(items[0].menuItem, 'Kinsta');
	return items[0].render();
}

test.after(() => dom.window.close());

test.afterEach(async () => {
	await act(async () => { ReactDOM.unmountComponentAtNode(document.getElementById('root')); });
	document.getElementById('popup-container').innerHTML = '';
});

test('registers stylesheet, tools tab, header, create-site option and route hooks', () => {
	assert.equal(registered.content.stylesheets.length, 1);
	const options = registered.filters['CreateSite:RadioOptions'][0]({ 'add-site': { label: 'Create a new site' } });
	assert.deepEqual(Object.keys(options), ['add-site', 'kinsta-pull']);
	assert.equal(options['kinsta-pull'].label, 'Pull from Kinsta');
	const route = registered.content['routes[main]'][0]({});
	assert.equal(route.props.path, '/main/kinsta-pull');
	assert.equal(registered.filters.siteInfoToolsItem.length, 1);
	assert.equal(registered.content.SiteInfo_Top_TopRight.length, 1);
	const link = registered.content.stylesheets[0]();
	assert.match(link.props.href, /lib\/renderer\/styles\.css$/);
});

const typeInto = async (input, value) => act(async () => {
	Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
	input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const fieldInput = (root, label) => [...root.querySelectorAll('.KNConnect_Field')]
	.find((f) => f.querySelector('.KNConnect_FieldLabel').textContent === label)
	.querySelector('input');

test('asks for a Kinsta API key when no account is connected', async () => {
	mainState = { account: null, link: null, publicKey: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.ok(tab(root, 'Kinsta API'));
	assert.ok(tab(root, 'SFTP/SSH details'));
	assert.match(root.textContent, /Company settings → API Keys/);
	assert.equal(fieldInput(root, 'API key').type, 'password', 'the key is masked');

	await typeInto(fieldInput(root, 'API key'), 'kinsta-key');
	ipcCalls.length = 0;
	await click(button(root, 'Connect account'));
	assert.deepEqual(ipcCalls.find(([ch]) => ch === IPC.CONNECT_ACCOUNT)[1], { apiKey: 'kinsta-key' });
});

test('lists environments grouped by site, skips blocked ones and links the chosen one', async () => {
	mainState = { account: { companyId: 'comp-1', keyName: 'Local dev', expiresAt: null }, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /Connected with API key Local dev/);
	assert.deepEqual([...root.querySelectorAll('select optgroup')].map((g) => g.label), ['Blog', 'Shop']);
	const options = [...root.querySelectorAll('select option')];
	assert.deepEqual(options.map((o) => o.textContent), ['Live — blog.example.com (blocked)', 'Live — shop.example.com', 'Staging — stg-shop-staging.kinsta.cloud']);
	assert.ok(options[0].disabled, 'a blocked environment cannot be picked');
	assert.equal(root.querySelector('select').value, 'env-live', 'the first usable environment is preselected');
	assert.match(root.textContent, /This is the live environment/);
	assert.equal(root.querySelector('textarea').value, 'ssh-rsa AAAAB3Nza test', 'shows Local\'s key to add in MyKinsta');

	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId, ...sent } = ipcCalls.find(([ch]) => ch === IPC.LINK_ACCOUNT_SITE)[1];
	assert.deepEqual(sent, { siteId: 'site1', kinstaSiteId: 's1', envId: 'env-live', siteName: 'Shop' });
	assert.match(progressId, /^link-/);
});

test('SFTP/SSH tab takes the login from MyKinsta, with no default port', async () => {
	mainState = { account: null, link: null, passwordAuthSupported: true };
	const root = await mount(toolsPanel());
	await click(tab(root, 'SFTP/SSH details'));
	assert.match(root.textContent, /Sites → your site → Info/);
	assert.equal(fieldInput(root, 'Port').value, '');
	await typeInto(fieldInput(root, 'Host'), '34.1.2.3');
	await typeInto(fieldInput(root, 'Port'), '31234');
	await typeInto(fieldInput(root, 'Username'), 'shopuser');
	await typeInto(fieldInput(root, 'Password'), 'pw');
	ipcCalls.length = 0;
	await click(button(root, 'Link Shop Local'));
	const { progressId, ...sent } = ipcCalls.find(([ch]) => ch === IPC.LINK_MANUAL)[1];
	assert.deepEqual(sent, { siteId: 'site1', host: '34.1.2.3', port: '31234', username: 'shopuser', authType: 'password', password: 'pw', remotePath: '', domain: '' });
});

test('linked site shows destination details and pushes with the chosen options', async () => {
	mainState = {
		account: null,
		passwordAuthSupported: true,
		link: {
			mode: 'account', authType: 'api-password', label: 'Shop (Live)', domain: 'shop.example.com', isLive: true, envId: 'env-live',
			host: '34.1.2.3', port: 31234, username: 'shopuser', remotePath: '/www/shop_123/public', nested: ['blog'],
		},
	};
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /shopuser@34\.1\.2\.3:31234/);
	assert.match(root.textContent, /\/www\/shop_123\/public/);
	assert.match(root.textContent, /Domainshop\.example\.com/);
	assert.match(root.textContent, /Other sites in subfolders: blog/);
	assert.match(root.textContent, /fetched from the Kinsta API for each transfer \(not stored\)/);
	assert.match(root.textContent, /Create a Kinsta backup first/);
	assert.match(root.textContent, /Clear Kinsta caches afterwards/);

	const pushButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Push to Kinsta' && b.getAttribute('role') !== 'tab');
	ipcCalls.length = 0;
	await act(async () => { pushButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const push = ipcCalls.find(([ch]) => ch === IPC.PUSH);
	assert.ok(push, 'push IPC should be sent');
	assert.deepEqual(push[1], {
		siteId: 'site1',
		options: { files: true, database: true, backup: true, deleteRemote: true, purgeCache: true },
	});
});

test('pull tab sends a pull with its own options', async () => {
	mainState = {
		account: null,
		link: { mode: 'manual', authType: 'key', host: '1.2.3.4', port: 22, username: 'abc', remotePath: '/www/shop_123/public', domain: 'shop.example.com' },
	};
	const root = await mount(toolsPanel());
	const pullTab = [...root.querySelectorAll('button[role="tab"]')].find((b) => b.textContent === 'Pull from Kinsta');
	await act(async () => { pullTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.match(root.textContent, /Back up the Local database first/);
	assert.match(root.textContent, /Delete Local files that are not on Kinsta/);
	assert.doesNotMatch(root.textContent, /Clear Kinsta caches|Kinsta backup/);

	const pullButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Pull from Kinsta' && b.getAttribute('role') !== 'tab');
	ipcCalls.length = 0;
	await act(async () => { pullButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
	const pull = ipcCalls.find(([ch]) => ch === IPC.PULL);
	assert.ok(pull, 'pull IPC should be sent');
	assert.deepEqual(pull[1], { siteId: 'site1', options: { files: true, database: true, backupLocal: true, deleteLocal: true } });
});

test('header buttons only appear for linked sites and open push/pull modals', async () => {
	mainState = { account: null, link: null };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'running'));
	assert.equal(root.textContent, '');

	// Linking elsewhere (e.g. in the Tools tab) broadcasts a state change; the header picks it up.
	mainState = { account: null, link: { mode: 'manual', authType: 'password', host: 'h', username: 'u', port: 22, domain: 'shop.example.com' } };
	await act(async () => {
		listeners[IPC.STATE_CHANGED].forEach((fn) => fn({}, 'site1'));
		await new Promise((r) => setTimeout(r, 10));
	});
	const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
	assert.deepEqual(labels, ['Pull', 'Push']);

	await act(async () => { root.querySelectorAll('button')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.match(document.body.textContent, /This overwrites the files and database of Shop Local in Local with shop\.example\.com/);
});

test('header shows progress and disables both buttons while a pull runs', async () => {
	mainState = { account: null, activity: 'pull', link: { mode: 'manual', authType: 'key', host: 'h', username: 'u', port: 22, domain: 'shop.example.com' } };
	const root = await mount(registered.content.SiteInfo_Top_TopRight[0](site, 'pulling'));
	const buttons = [...root.querySelectorAll('button')];
	assert.deepEqual(buttons.map((b) => b.textContent), ['Pulling…', 'Push']);
	// Local's buttons mark disabled state with aria-disabled and swallow clicks.
	assert.ok(buttons.every((b) => b.getAttribute('aria-disabled') === 'true'));
	await act(async () => { buttons[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
	assert.doesNotMatch(document.body.textContent, /This overwrites/, 'no modal while a transfer is running');
});

test('compare view groups differences and syncs only the selected files', async () => {
	mainState = {
		account: null,
		link: { mode: 'account', authType: 'key', host: '1.2.3.4', port: 22, username: 'abc', remotePath: '/www/shop_123/public', domain: 'shop.example.com' },
	};
	compareResult = {
		at: '2026-10-30T00:00:00Z',
		checksum: false,
		entries: [
			{ path: 'wp-content/themes/shop/style.css', type: 'file', status: 'changed', local: { size: 2048, mtime: 1790000000 }, remote: { size: 1900, mtime: 1780000000 }, newer: 'local' },
			{ path: 'wp-content/plugins/new/new.php', type: 'file', status: 'local-only', local: { size: 10, mtime: 1790000000 }, remote: null, newer: null },
			{ path: 'wp-content/uploads/2026/10/photo.jpg', type: 'file', status: 'remote-only', local: null, remote: { size: 3 * 1024 * 1024, mtime: 1790000000 }, newer: null },
		],
	};
	const root = await mount(toolsPanel());
	await click(tab(root, 'Compare & sync files'));
	ipcCalls.length = 0;
	await click(button(root, 'Compare with Kinsta'));
	assert.deepEqual(ipcCalls[0], [IPC.COMPARE, { siteId: 'site1', checksum: false }]);
	assert.match(root.textContent, /1 different on each side · 1 only in local · 1 only on kinsta/);
	assert.match(root.textContent, /Newer in Local/);
	assert.match(root.textContent, /3\.0 MB/);

	// Filter narrows the list
	const filter = root.querySelector('.KNConnect_Filter input');
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		setter.call(filter, 'themes');
		filter.dispatchEvent(new window.Event('input', { bubbles: true }));
	});
	assert.equal(root.querySelectorAll('.KNConnect_FileRow').length, 1);
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		setter.call(filter, '');
		filter.dispatchEvent(new window.Event('input', { bubbles: true }));
	});

	// Select the changed theme file and the remote-only upload, then push them
	const rows = [...root.querySelectorAll('.KNConnect_FileRow input')];
	await click(rows[0]);
	await click(rows[2]);
	assert.match(root.textContent, /2 selected/);
	ipcCalls.length = 0;
	await click(button(root, 'Push selected'));
	const push = ipcCalls.find(([ch]) => ch === IPC.PUSH);
	assert.deepEqual(push[1], {
		siteId: 'site1',
		options: { fileList: ['wp-content/themes/shop/style.css', 'wp-content/uploads/2026/10/photo.jpg'], purgeCache: true },
	});
	assert.ok(ipcCalls.some(([ch]) => ch === IPC.COMPARE), 'compares again after syncing');
});

test('create-site page pulls a Kinsta site into a new Local site', async () => {
	mainState = { account: { companyId: 'comp-1', keyName: 'Local dev', expiresAt: null }, link: null, passwordAuthSupported: true };
	const history = { pushed: [], push(p) { this.pushed.push(p); } };
	const route = registered.content['routes[main]'][0]({});
	const root = await mount(route.props.render({ history }));
	await act(async () => { await new Promise((r) => setTimeout(r, 250)); });

	assert.match(root.textContent, /Pull from Kinsta/);
	const nameInput = root.querySelector('input');
	assert.equal(nameInput.value, 'Shop', 'defaults to the selected site\'s name');
	assert.match(root.textContent, /shop\.local · ~\/Local Sites\/shop/);

	ipcCalls.length = 0;
	await click(button(root, 'Create site & pull'));
	const { siteName, source } = ipcCalls.find(([ch]) => ch === IPC.PULL_NEW_SITE)[1];
	const { progressId, ...rest } = source;
	assert.equal(siteName, 'Shop');
	assert.deepEqual(rest, { kind: 'account', kinstaSiteId: 's1', envId: 'env-live', siteName: 'Shop' });
	assert.match(progressId, /^link-/, 'lets the main process stream progress back to this form');
	assert.match(root.textContent, /Creating Shop at shop\.local/);

	await click(button(root, '← Back'));
	assert.deepEqual(history.pushed, ['/main/create-site']);
});

test('shows an available update and installs it through the main process', async () => {
	const update = { name: 'ConnectLocal for Kinsta', current: '0.1.0', latest: '0.2.0', releaseUrl: 'https://github.com/x/y/releases/tag/v0.2.0', devInstall: false, checking: false, installing: false, installed: false, error: null };
	mainState = { account: null, link: null, activity: null, publicKey: null, passwordAuthSupported: true, update };
	ipcCalls.length = 0;
	const root = await mount(toolsPanel());
	assert.match(root.textContent, /ConnectLocal for Kinsta 0\.2\.0 is available\. You have 0\.1\.0\./);
	await click(button(root, 'Update'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.INSTALL_UPDATE));

	mainState = { ...mainState, update: { ...update, installed: true } };
	await act(async () => { (listeners[IPC.STATE_CHANGED] || []).forEach((fn) => fn({}, null)); });
	await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
	assert.match(root.textContent, /0\.2\.0 is installed\. Restart Local/);
	await click(button(root, 'Restart Local'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.RESTART_LOCAL));
});

test('a development copy shows the update but no Update button, and the footer can check manually', async () => {
	const update = { name: 'ConnectLocal for Kinsta', current: '0.1.0', latest: null, releaseUrl: null, devInstall: true, checking: false, installing: false, installed: false, error: null };
	mainState = { account: null, link: null, activity: null, publicKey: null, passwordAuthSupported: true, update: { ...update, latest: '0.2.0' } };
	let root = await mount(toolsPanel());
	assert.match(root.textContent, /linked from a development folder/);
	assert.equal(button(root, 'Update'), undefined);
	await act(async () => { ReactDOM.unmountComponentAtNode(root); });

	mainState = { ...mainState, update };
	ipcCalls.length = 0;
	root = await mount(toolsPanel());
	assert.match(root.textContent, /ConnectLocal for Kinsta 0\.1\.0/);
	await click(button(root, 'Check for updates'));
	assert.ok(ipcCalls.some(([channel]) => channel === IPC.CHECK_UPDATE));
	assert.match(root.textContent, /You have the latest version\./);
});
