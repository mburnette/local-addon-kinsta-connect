'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LocalMain = require('@getflywheel/local/main');

const { IPC } = require('./constants');
const { KinstaApi } = require('./main/KinstaApi');
const { SyncService } = require('./main/SyncService');
const { SshKeyStore } = require('./main/sshKey');
const { Store } = require('./main/store');
const { findBundledBinDir, TransportError } = require('./main/transport');
const { Updater } = require('./main/updater');
const pkg = require('../package.json');

const HOSTNAME_RE = /^[a-z0-9.-]+$/i;
const isWindows = process.platform === 'win32';

function randomString(length, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
	const bytes = crypto.randomBytes(length);
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** "https://example.com/path" or "user@example.com" -> "example.com". */
const cleanHost = (host) => String(host || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/^[^@]*@/, '').split(/[/:]/)[0];

/** An SSH login the server turned down (as opposed to a network error or a missing WordPress). */
const isAuthRefusal = (e) => e instanceof TransportError && /refused the (SSH key|password)/.test(e.message);

/** Flattens the company's sites into one choice per environment, live first within each site. */
function toEnvironmentChoices(sites) {
	const choices = [];
	sites.forEach((site) => {
		(site.environments || []).forEach((env) => {
			const domains = (env.domains || []).map((d) => d && d.name).filter((d) => d && HOSTNAME_RE.test(d)).map((d) => d.toLowerCase());
			const primary = env.primaryDomain && env.primaryDomain.name ? env.primaryDomain.name.toLowerCase() : domains[0] || null;
			choices.push({
				kinstaSiteId: String(site.id),
				siteName: site.display_name || site.name || '',
				envId: String(env.id),
				envName: env.display_name || env.name,
				isLive: env.name === 'live',
				isBlocked: Boolean(env.is_blocked),
				domain: primary,
				altDomains: domains.filter((d) => d !== primary),
				webRoot: env.web_root || null,
				wordpressVersion: env.wordpress_version || null,
			});
		});
	});
	return choices.sort((a, b) => a.siteName.localeCompare(b.siteName) || Number(b.isLive) - Number(a.isLive) || a.envName.localeCompare(b.envName));
}

module.exports = function KinstaConnectMain(context) {
	const { electron } = context;
	const container = LocalMain.getServiceContainer().cradle;
	const logger = container.localLogger.child({ thread: 'main', addon: 'kinsta-connect' });
	const { sendIPCEvent } = LocalMain;

	const workDir = path.join(context.environment.userDataPath, 'kinsta-connect');
	const store = new Store(workDir, electron.safeStorage);
	const keys = new SshKeyStore(path.join(workDir, 'ssh'));

	let api = null;
	const getApi = () => {
		if (api) return api;
		const account = store.getAccount();
		if (!account) throw new Error('Connect your Kinsta account first.');
		api = new KinstaApi({ apiKey: account.apiKey, companyId: account.companyId, logger });
		return api;
	};

	/**
	 * Links that log in with the environment's SFTP/SSH password store no password: it is fetched from the Kinsta API
	 * for each transfer, so a password regenerated in MyKinsta keeps working.
	 */
	const resolveLink = async (link) => {
		if (!link || link.authType !== 'api-password') return link;
		let kinsta;
		try {
			kinsta = getApi();
		} catch (e) {
			throw new Error('This site logs in with its environment\'s SFTP/SSH password, which comes from the Kinsta API. '
				+ 'Connect your Kinsta account again under Tools → Kinsta, or add Local\'s SSH key in MyKinsta and link the site again.');
		}
		return { ...link, authType: 'password', password: await kinsta.getSshPassword(link.envId) };
	};

	const syncService = new SyncService({
		store,
		keys,
		workDir,
		getApi: () => (store.getAccount() ? getApi() : null),
		resolveLink,
		services: {
			siteData: container.siteData,
			siteDatabase: container.siteDatabase,
			siteProcessManager: container.siteProcessManager,
			wpCli: container.wpCli,
		},
		sendIPCEvent,
		logger,
	});

	const updater = new Updater({
		pkg,
		addonDir: path.resolve(__dirname, '..'),
		addonsDir: path.join(context.environment.userDataPath, 'addons'),
		ipcMain: electron.ipcMain,
		app: electron.app,
		logger,
		onChange: () => broadcast(),
	});
	if (electron.app) updater.start();

	const keyComment = () => `local-kinsta-connect@${os.hostname()}`.replace(/\s+/g, '-');

	const getState = (siteId) => ({
		account: store.getPublicAccount(),
		link: siteId ? store.getPublicLink(siteId) : null,
		activity: siteId ? syncService.activity(siteId) : null,
		publicKey: keys.getPublicKey(),
		passwordAuthSupported: !isWindows,
		update: updater.state(),
	});

	const broadcast = (siteId) => sendIPCEvent(IPC.STATE_CHANGED, siteId || null);

	/** Sends step-by-step linking progress to the form that started it (matched by its progressId). */
	const progressReporter = (progressId) => (message) => {
		logger.info(`Linking: ${message}`);
		if (progressId) sendIPCEvent(IPC.LINK_PROGRESS, progressId, message);
	};

	/** Broadcasts once a transfer has registered as active, and again when it settles. */
	const runAndBroadcast = async (siteId, transfer) => {
		broadcast(siteId);
		try {
			return await transfer;
		} finally {
			broadcast(siteId);
		}
	};

	/** Locates WordPress over an SSH login, installing WP-CLI if the server lacks it. */
	const locate = async (login, hints, onProgress) => {
		const transport = syncService.transportFor(login);
		try {
			let remote = await syncService.discoverRemote(transport, hints);
			if (!remote.hasWpCli && remote.hasPhp) {
				onProgress('WP-CLI is missing on the server; installing it in a private folder…');
				remote = await syncService.ensureWpCli(transport, remote);
			}
			return remote;
		} finally {
			await transport.close();
		}
	};

	const remoteFields = (remote) => ({ remotePath: remote.remotePath, privateDir: remote.privateDir, nested: remote.nested });

	/**
	 * Links a Kinsta environment through the API: reads its SSH login, turns SFTP/SSH on if it is off, and logs in
	 * with Local's SSH key. If MyKinsta doesn't have that key yet, it logs in with the environment's SFTP/SSH password
	 * from the API instead. Returns the link to store; nothing is saved yet.
	 */
	const prepareAccountLink = async ({ kinstaSiteId, envId, siteName }, onProgress = () => {}) => {
		const kinsta = getApi();
		if (!kinstaSiteId || !envId) throw new Error('Choose a Kinsta site and environment from the list.');
		onProgress('Reading the environment from Kinsta…');
		const choice = toEnvironmentChoices([{
			id: kinstaSiteId,
			display_name: String(siteName || '').trim(),
			environments: await kinsta.getEnvironments(kinstaSiteId),
		}]).find((c) => c.envId === String(envId));
		if (!choice) throw new Error('That Kinsta environment could not be found. Refresh the list and try again.');
		if (choice.isBlocked) throw new Error('Kinsta has blocked this environment, so it cannot be reached over SSH. Check MyKinsta for details.');

		let sshEnabled = true;
		try {
			sshEnabled = await kinsta.getSshEnabled(envId);
		} catch (e) {
			// Not fatal: the SSH login below reports a clear error if access really is off.
			logger.warn(`Could not read the SFTP/SSH status of environment ${envId}: ${e.message}`);
		}
		if (!sshEnabled) {
			onProgress('Turning on SFTP/SSH for the environment…');
			await kinsta.enableSsh(envId);
		}

		const ssh = await kinsta.getSshConfig(kinstaSiteId, envId);
		if (!ssh.host || !ssh.port || !ssh.username) throw new Error('Kinsta did not return the SSH host, port and username for this environment.');
		keys.ensure(keyComment());

		const link = {
			mode: 'account',
			kinstaSiteId: String(kinstaSiteId),
			envId: String(envId),
			siteName: choice.siteName || null,
			envName: choice.envName,
			label: `${choice.siteName || choice.domain || ssh.host} (${choice.envName})`,
			isLive: choice.isLive,
			host: cleanHost(ssh.host),
			port: ssh.port,
			username: ssh.username,
			domain: choice.domain,
			altDomains: choice.altDomains,
			webRoot: choice.webRoot,
			authType: 'key',
		};
		const hints = { webRoot: choice.webRoot };

		onProgress('Connecting with Local\'s SSH key…');
		try {
			return { ...link, ...remoteFields(await locate(link, hints, onProgress)) };
		} catch (e) {
			if (!isAuthRefusal(e)) throw e;
			logger.info(`Kinsta refused Local's SSH key for environment ${envId}; trying the SFTP/SSH password from the API.`);
		}
		const addKeyHint = 'Add Local\'s public key (shown on this page) in MyKinsta → User settings → SSH keys, then link again.';
		if (isWindows) throw new Error(`Kinsta refused Local's SSH key. ${addKeyHint}`);

		onProgress('Local\'s SSH key isn\'t in MyKinsta yet; connecting with the environment\'s SFTP/SSH password instead…');
		const password = await kinsta.getSshPassword(envId);
		try {
			const remote = await locate({ ...link, authType: 'password', password }, hints, onProgress);
			return { ...link, authType: 'api-password', ...remoteFields(remote) };
		} catch (e) {
			if (!isAuthRefusal(e)) throw e;
			throw new Error('Kinsta refused both Local\'s SSH key and the environment\'s SFTP/SSH password. Password login may be '
				+ `turned off for this environment (MyKinsta → Sites → ${choice.siteName || 'your site'} → Info → SFTP/SSH). ${addKeyHint}`);
		}
	};

	/** Builds and verifies a link from SFTP/SSH details copied from MyKinsta. Nothing is saved yet. */
	const prepareManualLink = async ({ host, port, username, authType, password, remotePath, domain }, onProgress = () => {}) => {
		if (authType === 'password' && isWindows) {
			throw new Error('Password authentication is not supported on Windows yet. Use the SSH key option instead.');
		}
		if (authType !== 'password') keys.ensure(keyComment());
		const link = {
			mode: 'manual',
			authType: authType === 'password' ? 'password' : 'key',
			host: cleanHost(host),
			port: Number(port) || 22,
			username: String(username || '').trim(),
			password: authType === 'password' ? password : null,
			domain: domain ? String(domain).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') : null,
		};
		if (!link.host || !HOSTNAME_RE.test(link.host)) throw new Error('Enter the host IP shown under SFTP/SSH in MyKinsta.');
		if (!link.username) throw new Error('Enter the SFTP/SSH username shown in MyKinsta.');
		link.label = link.domain;
		onProgress('Connecting over SSH…');
		const remote = await locate(link, { remotePath: remotePath ? String(remotePath).trim() : null }, onProgress);
		return { ...link, ...remoteFields(remote) };
	};

	const prepareLink = (source, onProgress) => (source && source.kind === 'manual'
		? prepareManualLink(source, onProgress)
		: prepareAccountLink(source || {}, onProgress));

	/** Name, domain and folder for a new Local site, following Local's new-site defaults and avoiding clashes. */
	const newSiteLocation = (siteName) => {
		const defaults = {
			sitesPath: '~/Local Sites/',
			tld: '.local',
			environment: 'flywheel',
			adminEmail: 'dev-email@wpengine.local',
			...(LocalMain.UserData ? LocalMain.UserData.get('settings-new-site-defaults', {}) : {}),
		};
		const slug = String(siteName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'kinsta-site';
		const sites = Object.values(container.siteData.getSites());
		const tld = `.${String(defaults.tld).replace(/^\.+/, '')}`;
		const expand = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
		for (let i = 1; i < 1000; i += 1) {
			const candidate = i === 1 ? slug : `${slug}-${i}`;
			const domain = `${candidate}${tld}`;
			const sitePath = path.join(defaults.sitesPath, candidate);
			const taken = sites.some((s) => s.domain === domain || path.resolve(expand(s.path)) === path.resolve(expand(sitePath)));
			if (!taken && !fs.existsSync(expand(sitePath))) {
				return { siteName: String(siteName).trim(), domain, sitePath, defaults };
			}
		}
		throw new Error('Could not find a free folder for the new site.');
	};

	const handlers = {
		[IPC.GET_STATE]: (siteId) => getState(siteId),

		[IPC.GET_PUBLIC_KEY]: () => keys.ensure(keyComment()),

		[IPC.CHECK_UPDATE]: () => updater.check({ manual: true }),

		[IPC.INSTALL_UPDATE]: () => updater.install(),

		[IPC.RESTART_LOCAL]: () => updater.restart(),

		[IPC.CONNECT_ACCOUNT]: async ({ apiKey }) => {
			// Keys contain no whitespace; copy-paste can bring along spaces, line breaks or zero-width characters.
			const cleanKey = String(apiKey || '').replace(/[\s​-‍⁠﻿]/g, '');
			if (!cleanKey) throw new Error('Paste a Kinsta API key.');
			const candidate = new KinstaApi({ apiKey: cleanKey, logger });
			const { name, expiresAt, companyId } = await candidate.validate();
			store.setAccount({ apiKey: cleanKey, companyId, keyName: name, expiresAt });
			api = candidate;
			broadcast();
			return getState();
		},

		[IPC.DISCONNECT_ACCOUNT]: () => {
			store.clearAccount();
			api = null;
			broadcast();
			return getState();
		},

		[IPC.LIST_SITES]: async () => toEnvironmentChoices(await getApi().listSites()),

		[IPC.LINK_ACCOUNT_SITE]: async ({ siteId, progressId, ...choice }) => {
			store.setLink(siteId, await prepareAccountLink(choice, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.LINK_MANUAL]: async ({ siteId, progressId, ...credentials }) => {
			store.setLink(siteId, await prepareManualLink(credentials, progressReporter(progressId)));
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.COMPARE]: ({ siteId, checksum }) => runAndBroadcast(siteId, syncService.compare(siteId, { checksum })),

		[IPC.NEW_SITE_LOCATION]: (siteName) => {
			const { domain, sitePath } = newSiteLocation(siteName);
			return { domain, sitePath };
		},

		/**
		 * "Pull to a new site": verifies the Kinsta connection first (so a bad login never leaves an empty site
		 * behind), then creates a regular Local site with Local's own add-site service, links it and pulls.
		 * Resolves once the connection is verified; creation and the pull report progress in Local's site overlay.
		 */
		[IPC.PULL_NEW_SITE]: async ({ siteName, source }) => {
			if (!siteName || !String(siteName).trim()) throw new Error('Enter a name for the new site.');
			const link = await prepareLink(source, progressReporter(source && source.progressId));
			const location = newSiteLocation(siteName);

			(async () => {
				let site;
				try {
					site = await container.addSite.addSite({
						newSiteInfo: {
							siteName: location.siteName,
							siteDomain: location.domain,
							sitePath: location.sitePath,
							environment: location.defaults.environment,
							multiSite: '',
						},
						wpCredentials: {
							adminUsername: 'admin',
							adminPassword: randomString(20),
							adminEmail: location.defaults.adminEmail,
						},
						goToSite: true,
						installWP: true,
					});
				} catch (e) {
					// Local shows its own error dialog for failed site creation.
					logger.error(`Could not create the Local site for a Kinsta pull: ${e.message}`);
					return;
				}
				store.setLink(site.id, link);
				broadcast(site.id);
				try {
					await runAndBroadcast(site.id, syncService.pull(site.id, { deleteLocal: true, backupLocal: false }));
				} catch (e) {
					// Reported through the site banner.
				}
			})();

			return { domain: location.domain, sitePath: location.sitePath };
		},

		[IPC.UNLINK_SITE]: ({ siteId }) => {
			store.removeLink(siteId);
			broadcast(siteId);
			return getState(siteId);
		},

		[IPC.TEST_CONNECTION]: async (siteId) => {
			const link = store.getLink(siteId);
			if (!link) throw new Error('This site is not linked to Kinsta yet.');
			const transport = syncService.transportFor(await resolveLink(link));
			try {
				const remote = await syncService.discoverRemote(transport, { remotePath: link.remotePath });
				store.updateLink(siteId, remoteFields(remote));
				broadcast(siteId);
				return remote;
			} finally {
				await transport.close();
			}
		},

		// Outcomes are reported through site banners like Local Connect; the IPC reply only signals completion.
		[IPC.PUSH]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.push(siteId, options)),

		[IPC.PULL]: ({ siteId, options }) => runAndBroadcast(siteId, syncService.pull(siteId, options)),
	};

	Object.entries(handlers).forEach(([channel, handler]) => LocalMain.addIpcAsyncListener(channel, handler));

	logger.info(`ConnectLocal for Kinsta loaded (rsync/ssh from ${findBundledBinDir() || 'system PATH'})`);
};

module.exports.toEnvironmentChoices = toEnvironmentChoices;
