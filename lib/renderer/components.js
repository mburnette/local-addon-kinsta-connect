'use strict';

const { ipcRenderer, shell } = require('electron');
const { ipcAsync, confirm } = require('@getflywheel/local/renderer');
const {
	Button,
	Checkbox,
	BasicInput,
	FlyModal,
	PrimaryButton,
	Spinner,
	TextButton,
	Title,
} = require('@getflywheel/local-components');

const { IPC } = require('../constants');

const API_KEY_HELP_URL = 'https://kinsta.com/docs/kinsta-api/';
const SSH_HELP_URL = 'https://kinsta.com/docs/connect-to-ssh/';

const errorText = (e) => (e && (e.messageMain || e.message)) || String(e);

module.exports = function createComponents({ React }) {
	const h = React.createElement;
	const { useCallback, useEffect, useState } = React;

	/** Loads add-on state for a site and keeps it fresh when the main process reports changes. */
	function useKinstaState(siteId) {
		const [state, setState] = useState(null);
		const refresh = useCallback(() => ipcAsync(IPC.GET_STATE, siteId).then(setState).catch(() => {}), [siteId]);
		useEffect(() => {
			refresh();
			const onChange = (_event, changedSiteId) => {
				if (!changedSiteId || changedSiteId === siteId) refresh();
			};
			ipcRenderer.on(IPC.STATE_CHANGED, onChange);
			return () => ipcRenderer.removeListener(IPC.STATE_CHANGED, onChange);
		}, [siteId, refresh]);
		return [state, refresh];
	}

	/** Wraps an async action with busy + error state. */
	function useAction() {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const run = useCallback(async (fn) => {
			setBusy(true);
			setError(null);
			try {
				return await fn();
			} catch (e) {
				setError(errorText(e));
				return undefined;
			} finally {
				setBusy(false);
			}
		}, []);
		return { busy, error, setError, run };
	}

	/** Step-by-step progress the main process reports while connecting or linking. `start()` returns a progressId. */
	function useLinkProgress() {
		const [progress, setProgress] = useState(null);
		const idRef = React.useRef(null);
		useEffect(() => {
			const onProgress = (_event, id, message) => {
				if (id && id === idRef.current) setProgress(message);
			};
			ipcRenderer.on(IPC.LINK_PROGRESS, onProgress);
			return () => ipcRenderer.removeListener(IPC.LINK_PROGRESS, onProgress);
		}, []);
		const start = () => {
			idRef.current = `link-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			setProgress(null);
			return idRef.current;
		};
		return { progress, start };
	}

	const isChecked = (value, previous) => (typeof value === 'boolean' ? value : !previous);

	const openLink = (url) => (e) => {
		e.preventDefault();
		shell.openExternal(url);
	};

	function Field({ label, help, children }) {
		return h('label', { className: 'KNConnect_Field' },
			h('span', { className: 'KNConnect_FieldLabel' }, label),
			children,
			help ? h('span', { className: 'KNConnect_Help' }, help) : null);
	}

	function TextInput({ value, onChange, type = 'text', placeholder, disabled }) {
		return h(BasicInput, {
			type,
			value: value || '',
			placeholder,
			disabled,
			onChange: (e) => onChange(e.target.value),
		});
	}

	function ErrorNote({ error }) {
		return error ? h('div', { className: 'KNConnect_Error', role: 'alert' }, error) : null;
	}

	function BusyNote({ busy, children }) {
		return busy ? h('div', { className: 'KNConnect_Busy' }, h(Spinner, null), h('span', null, children)) : null;
	}

	function Tabs({ value, onChange, tabs, className = 'KNConnect_Tabs' }) {
		return h('div', { className, role: 'tablist' },
			tabs.map(([key, label]) => h('button', {
				key,
				type: 'button',
				role: 'tab',
				'aria-selected': value === key,
				className: `KNConnect_Tab${value === key ? ' is-active' : ''}`,
				onClick: () => onChange(key),
			}, label)));
	}

	function PublicKeyBox() {
		const [publicKey, setPublicKey] = useState('');
		const [copied, setCopied] = useState(false);
		useEffect(() => {
			ipcAsync(IPC.GET_PUBLIC_KEY).then(setPublicKey).catch(() => {});
		}, []);
		const copy = () => {
			navigator.clipboard.writeText(publicKey).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			});
		};
		return h('div', { className: 'KNConnect_KeyBox' },
			h('textarea', { readOnly: true, value: publicKey, rows: 4, className: 'KNConnect_KeyText' }),
			h(TextButton, { onClick: copy, disabled: !publicKey }, copied ? 'Copied' : 'Copy public key'));
	}

	/** Password or SSH key, as radio buttons. Password is offered only where the platform supports it. */
	function AuthChoice({ state, value, onChange }) {
		return h('div', { className: 'KNConnect_AuthChoice' },
			state.passwordAuthSupported
				? h('label', null, h('input', { type: 'radio', checked: value === 'password', onChange: () => onChange('password') }), ' Password')
				: null,
			h('label', null, h('input', { type: 'radio', checked: value === 'key', onChange: () => onChange('key') }), ' SSH key'));
	}

	/** Options, wording and channel for each direction. */
	const DIRECTIONS = {
		push: {
			channel: IPC.PUSH,
			verb: 'Push',
			gerund: 'Pushing',
			button: 'Push to Kinsta',
			defaults: (link) => ({ files: true, database: true, backup: link.mode === 'account', deleteRemote: true, purgeCache: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in app/public except wp-config.php)'],
				['database', 'Database (with URL search & replace)'],
				link.mode === 'account' && ['backup', 'Create a Kinsta backup first'],
				options.files && ['deleteRemote', 'Delete files on Kinsta that are not in Local'],
				['purgeCache', 'Clear Kinsta caches afterwards'],
			],
			consequences: ({ what, where, site, link, options }) => [
				`This overwrites the ${what} on ${where} with ${site.name} from Local.`,
				link.isLive && 'This is the live environment: visitors see the change right away.',
				options.backup && 'Kinsta creates a manual backup of the environment first; you can restore it under Backups in MyKinsta.',
				options.database && 'The Kinsta database is replaced; the previous one is also saved as local-backup-before-push.sql in a private .kinsta-connect folder outside the webroot.',
				options.files && options.deleteRemote && 'Files on Kinsta that do not exist locally will be deleted. Kinsta\'s must-use plugin and other sites in subfolders are never touched.',
			],
		},
		pull: {
			channel: IPC.PULL,
			verb: 'Pull',
			gerund: 'Pulling',
			button: 'Pull from Kinsta',
			defaults: () => ({ files: true, database: true, backupLocal: true, deleteLocal: true }),
			checkboxes: (link, options) => [
				['files', 'Files (everything in the webroot except wp-config.php, server config and caches)'],
				['database', 'Database (with URL search & replace)'],
				options.database && ['backupLocal', 'Back up the Local database first'],
				options.files && ['deleteLocal', 'Delete Local files that are not on Kinsta'],
			],
			consequences: ({ what, where, site, options }) => [
				`This overwrites the ${what} of ${site.name} in Local with ${where}.`,
				options.database && (options.backupLocal
					? 'The Local database is replaced; the previous one is saved in app/sql/local-backup-before-pull.sql.'
					: 'The Local database is replaced without a backup.'),
				options.files && options.deleteLocal && 'Local files that do not exist on Kinsta will be deleted.',
				options.files && 'Local files the pull replaces or deletes are moved to app/kinsta-backups (the last 3 pulls are kept).',
			],
		},
	};

	const linkTarget = (link) => link.label || link.domain || link.host;

	/**
	 * Push or pull options, shared by the Tools panel and the header modal. Inside the modal the modal itself is the
	 * confirmation and it closes as soon as the transfer starts (progress shows in the site overlay, like Local Connect).
	 */
	function TransferForm({ direction, site, link, activity, inModal = false, onStarted }) {
		const config = DIRECTIONS[direction];
		const [options, setOptions] = useState(() => config.defaults(link));
		const { busy, error, run } = useAction();
		const toggle = (key) => (value) => setOptions((o) => ({ ...o, [key]: isChecked(value, o[key]) }));
		const nothingSelected = !options.files && !options.database;
		const where = linkTarget(link);
		const what = options.files && options.database ? 'files and database' : options.files ? 'files' : 'database';
		const consequences = config.consequences({ what, where, site, link, options }).filter(Boolean);
		const running = busy || activity === direction;

		const start = async () => {
			if (!inModal) {
				await confirm({
					title: `${config.verb} ${what} ${direction === 'push' ? 'to' : 'from'} Kinsta?`,
					message: h('div', null, consequences.map((text) => h('p', { key: text }, text))),
					buttonText: config.verb,
				});
			}
			const request = ipcAsync(config.channel, { siteId: site.id, options });
			if (onStarted) {
				onStarted();
				// Failures surface as a site banner, as with Local Connect.
				request.catch(() => {});
				return;
			}
			await run(() => request);
		};

		return h('div', { className: 'KNConnect_TransferForm' },
			h('div', { className: 'KNConnect_Options' },
				config.checkboxes(link, options).filter(Boolean).map(([key, label]) => h(Checkbox, {
					key,
					label,
					checked: options[key],
					onChange: toggle(key),
				}))),
			inModal ? h('ul', { className: 'KNConnect_Consequences' }, consequences.map((text) => h('li', { key: text }, text))) : null,
			h(ErrorNote, { error }),
			h('div', { className: 'KNConnect_Actions' },
				h(PrimaryButton, { onClick: start, disabled: running || Boolean(activity) || nothingSelected }, running ? `${config.gerund}…` : config.button)));
	}

	const AUTH_LABELS = {
		key: 'Local\'s SSH key',
		'api-password': 'SFTP/SSH password, fetched from the Kinsta API for each transfer (not stored). Add Local\'s SSH key in MyKinsta and link again to use the key instead.',
		password: 'SFTP/SSH password (stored encrypted)',
	};

	const describeLast = (last) => `${new Date(last.at).toLocaleString()} (${[last.files && 'files', last.database && 'database'].filter(Boolean).join(' + ')}, ${last.seconds}s)`;

	function LinkedView({ site, state }) {
		const { link } = state;
		const test = useAction();
		const unlink = useAction();
		const [testResult, setTestResult] = useState(null);
		const [direction, setDirection] = useState('push');

		const rows = [
			link.label && ['Site', link.label],
			link.domain && !String(link.label || '').includes(link.domain) && ['Domain', link.domain],
			['SSH', `${link.username}@${link.host}${Number(link.port) !== 22 ? `:${link.port}` : ''}`],
			['Remote path', link.remotePath],
			link.nested && link.nested.length ? ['Never synced', `Other sites in subfolders: ${link.nested.join(', ')}`] : null,
			['Authentication', AUTH_LABELS[link.authType] || AUTH_LABELS.key],
			link.lastPush && ['Last push', describeLast(link.lastPush)],
			link.lastPull && ['Last pull', describeLast(link.lastPull)],
		].filter(Boolean);

		return h('div', null,
			h('table', { className: 'KNConnect_Table' },
				h('tbody', null, rows.map(([k, v]) => h('tr', { key: k }, h('th', null, k), h('td', null, v))))),
			h(Tabs, {
				value: direction,
				onChange: setDirection,
				tabs: [['push', 'Push to Kinsta'], ['pull', 'Pull from Kinsta'], ['compare', 'Compare & sync files']],
				className: 'KNConnect_Tabs KNConnect_Tabs--Transfer',
			}),
			direction === 'compare'
				? h(CompareView, { site, activity: state.activity })
				: h(TransferForm, { key: direction, direction, site, link, activity: state.activity }),
			h('div', { className: 'KNConnect_Secondary' },
				h(TextButton, {
					disabled: test.busy,
					onClick: () => test.run(async () => {
						setTestResult(null);
						const remote = await ipcAsync(IPC.TEST_CONNECTION, site.id);
						setTestResult(`Connected. WordPress found at ${remote.remotePath}${remote.hasWpCli ? '' : ' (WP-CLI missing: database transfers will fail)'}.`);
					}),
				}, test.busy ? 'Testing…' : 'Test connection'),
				h(TextButton, {
					intent: 'destructive',
					disabled: unlink.busy || Boolean(state.activity),
					onClick: () => unlink.run(() => ipcAsync(IPC.UNLINK_SITE, { siteId: site.id })),
				}, 'Unlink from Kinsta')),
			testResult ? h('div', { className: 'KNConnect_Success' }, testResult) : null,
			h(ErrorNote, { error: test.error || unlink.error }));
	}

	/** Connects a Kinsta API key, which lists the company's sites and environments with their SSH details. */
	function AccountConnectForm() {
		const [apiKey, setApiKey] = useState('');
		const action = useAction();

		return h('div', { className: 'KNConnect_Form' },
			h('p', { className: 'KNConnect_Intro' },
				'Connect with a Kinsta API key. Local then finds your sites, their SSH logins and paths for you, and creates backups and clears caches through the API. In MyKinsta, open ',
				h('strong', null, 'your name → Company settings → API Keys'),
				' and click Create API Key. ',
				h('a', { href: '#', onClick: openLink(API_KEY_HELP_URL) }, 'Kinsta\'s guide')),
			h(Field, { label: 'API key', help: 'The key has the same access as the MyKinsta user who creates it. It is stored encrypted with your system keychain.' },
				h(TextInput, { value: apiKey, onChange: setApiKey, type: 'password' })),
			h(BusyNote, { busy: action.busy }, 'Checking the key…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'KNConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !apiKey.trim(),
					onClick: () => action.run(() => ipcAsync(IPC.CONNECT_ACCOUNT, { apiKey })),
				}, action.busy ? 'Connecting…' : 'Connect account')));
	}

	const envLabel = (env) => `${env.envName}${env.domain ? ` — ${env.domain}` : ''}${env.isBlocked ? ' (blocked)' : ''}`;
	const describeExpiry = (expiresAt) => (expiresAt ? `, expires ${new Date(expiresAt).toLocaleDateString()}` : '');

	/**
	 * Picks a site environment from the connected Kinsta company. `onSubmit({ kind: 'account', kinstaSiteId, envId, … })`
	 * links it (or, on the new-site page, creates a site and pulls it).
	 */
	function AccountSetup({ state, submitLabel, canSubmit = true, onSubmit, onSiteSelected }) {
		const [envs, setEnvs] = useState(null);
		const [selected, setSelected] = useState('');
		const action = useAction();
		const { progress, start } = useLinkProgress();

		const loadSites = useCallback(() => action.run(async () => {
			const list = await ipcAsync(IPC.LIST_SITES);
			setEnvs(list);
			const first = list.find((e) => !e.isBlocked) || list[0];
			if (first) setSelected(first.envId);
		}), [action.run]);

		useEffect(() => {
			if (state.account && envs === null) loadSites();
		}, [state.account]);

		const choice = envs && envs.find((e) => e.envId === selected);

		useEffect(() => {
			if (choice && onSiteSelected) onSiteSelected(choice);
		}, [choice && choice.envId]);

		if (!state.account) return h(AccountConnectForm);

		const { account } = state;
		const sites = envs ? [...new Set(envs.map((e) => e.kinstaSiteId))].map((id) => envs.filter((e) => e.kinstaSiteId === id)) : [];
		return h('div', { className: 'KNConnect_Form' },
			h('div', { className: 'KNConnect_Account' },
				h('span', null, 'Connected with API key ', h('strong', null, account.keyName || 'Kinsta'), describeExpiry(account.expiresAt)),
				h(TextButton, {
					onClick: () => action.run(async () => {
						await ipcAsync(IPC.DISCONNECT_ACCOUNT);
						setEnvs(null);
					}),
				}, 'Disconnect')),
			envs === null
				? h(BusyNote, { busy: true }, 'Loading your Kinsta sites…')
				: envs.length === 0
					? h('p', null, 'No sites were found for this API key\'s company. Sites in another company need a key created there; or link with SFTP/SSH details instead.')
					: h(Field, { label: 'Site and environment', help: choice && choice.isLive ? 'This is the live environment. Pick a staging environment to try things safely.' : null },
						h('select', { className: 'KNConnect_Select', value: selected, onChange: (e) => setSelected(e.target.value) },
							sites.map((group) => h('optgroup', { key: group[0].kinstaSiteId, label: group[0].siteName },
								group.map((env) => h('option', { key: env.envId, value: env.envId, disabled: env.isBlocked }, envLabel(env))))))),
			envs && envs.length
				? h(Field, {
					label: 'Local\'s SSH key (optional)',
					help: 'Add it in MyKinsta under your name → User settings → SSH keys and Local logs in with it. Without it, Local uses the environment\'s SFTP/SSH password from the API each time.',
				}, h(PublicKeyBox))
				: null,
			h(BusyNote, { busy: action.busy && envs !== null }, progress || 'Linking…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'KNConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !choice || choice.isBlocked || !canSubmit,
					onClick: () => action.run(() => onSubmit({
						kind: 'account',
						kinstaSiteId: choice.kinstaSiteId,
						envId: choice.envId,
						siteName: choice.siteName,
						progressId: start(),
					})),
				}, submitLabel),
				h(TextButton, { disabled: action.busy, onClick: loadSites }, 'Refresh list')));
	}

	/** SFTP/SSH details copied from MyKinsta (Sites → your site → Info), for users without an API key. `onSubmit({ kind: 'manual', … })`. */
	function ManualSetup({ state, submitLabel, canSubmit = true, onSubmit }) {
		const [form, setForm] = useState({ host: '', port: '', username: '', authType: state.passwordAuthSupported ? 'password' : 'key', password: '', remotePath: '', domain: '' });
		const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
		const action = useAction();
		const { progress, start } = useLinkProgress();
		const complete = form.host.trim() && form.port.trim() && form.username.trim() && (form.authType === 'key' || form.password);

		return h('div', { className: 'KNConnect_Form' },
			h('p', { className: 'KNConnect_Intro' },
				'No API key? Copy the login from MyKinsta: open ',
				h('strong', null, 'Sites → your site → Info'),
				' and look under SFTP/SSH (pick the environment at the top first). Each environment has its own port. ',
				h('a', { href: '#', onClick: openLink(SSH_HELP_URL) }, 'Kinsta\'s guide')),
			h('div', { className: 'KNConnect_Row' },
				h(Field, { label: 'Host', help: 'The IP address shown under SFTP/SSH.' }, h(TextInput, { value: form.host, onChange: set('host'), placeholder: '203.0.113.10' })),
				h(Field, { label: 'Port' }, h(TextInput, { value: form.port, onChange: set('port'), placeholder: '12345' }))),
			h(Field, { label: 'Username' }, h(TextInput, { value: form.username, onChange: set('username') })),
			h(AuthChoice, { state, value: form.authType, onChange: set('authType') }),
			form.authType === 'password'
				? h(Field, { label: 'Password', help: 'Shown under SFTP/SSH. Stored encrypted with your system keychain.' }, h(TextInput, { value: form.password, onChange: set('password'), type: 'password' }))
				: h(Field, { label: 'Public key', help: 'Add it in MyKinsta under your name → User settings → SSH keys first.' }, h(PublicKeyBox)),
			h(Field, { label: 'Remote path (optional)', help: 'The folder that holds wp-config.php. Detected automatically when left empty.' },
				h(TextInput, { value: form.remotePath, onChange: set('remotePath'), placeholder: 'auto-detect' })),
			h(Field, { label: 'Site domain (optional)', help: 'Only used if the Kinsta database has no home URL yet.' },
				h(TextInput, { value: form.domain, onChange: set('domain'), placeholder: 'example.com' })),
			h(BusyNote, { busy: action.busy }, progress || 'Connecting…'),
			h(ErrorNote, { error: action.error }),
			h('div', { className: 'KNConnect_Actions' },
				h(PrimaryButton, {
					disabled: action.busy || !complete || !canSubmit,
					onClick: () => action.run(() => onSubmit({ kind: 'manual', ...form, progressId: start() })),
				}, action.busy ? 'Connecting…' : submitLabel)));
	}

	function SetupView(props) {
		const [mode, setMode] = useState('account');
		return h('div', null,
			h(Tabs, { value: mode, onChange: setMode, tabs: [['account', 'Kinsta API'], ['manual', 'SFTP/SSH details']] }),
			mode === 'account' ? h(AccountSetup, props) : h(ManualSetup, props));
	}

	// ---------------------------------------------------------------- updates

	/** Announces a newer release and installs it through Local's add-on installer. */
	function UpdateNotice({ update }) {
		const action = useAction();
		if (!update) return null;
		const error = action.error || update.error;
		if (update.installed) {
			return h('div', { className: 'KNConnect_Update', role: 'status' },
				h('span', null, `${update.name} ${update.latest} is installed. Restart Local to start using it.`),
				h('div', { className: 'KNConnect_UpdateActions' },
					h(PrimaryButton, { onClick: () => action.run(() => ipcAsync(IPC.RESTART_LOCAL)) }, 'Restart Local')));
		}
		if (!update.latest) return error && !update.checking ? h(ErrorNote, { error }) : null;
		const busy = action.busy || update.installing;
		return h('div', { className: 'KNConnect_Update', role: 'status' },
			h('span', null, `${update.name} ${update.latest} is available. You have ${update.current}.`),
			update.devInstall
				? h('span', { className: 'KNConnect_Help' }, 'This copy is linked from a development folder, so update that folder instead.')
				: null,
			h('div', { className: 'KNConnect_UpdateActions' },
				update.devInstall
					? null
					: h(PrimaryButton, { disabled: busy, onClick: () => action.run(() => ipcAsync(IPC.INSTALL_UPDATE)) }, busy ? 'Updating…' : 'Update'),
				update.releaseUrl ? h(TextButton, { onClick: () => shell.openExternal(update.releaseUrl) }, 'What\'s new') : null),
			error ? h(ErrorNote, { error }) : null);
	}

	/** Version line with a manual "Check for updates". */
	function VersionFooter({ update }) {
		const [checked, setChecked] = useState(false);
		if (!update) return null;
		const check = () => ipcAsync(IPC.CHECK_UPDATE).then(() => setChecked(true)).catch(() => {});
		const upToDate = checked && !update.checking && !update.latest && !update.error;
		return h('div', { className: 'KNConnect_Version' },
			h('span', null, `${update.name} ${update.current}`),
			update.checking
				? h('span', null, 'Checking for updates…')
				: upToDate
					? h('span', null, 'You have the latest version.')
					: update.latest ? null : h(TextButton, { onClick: check }, 'Check for updates'));
	}

	const linkSite = (siteId) => ({ kind, ...source }) => (kind === 'account'
		? ipcAsync(IPC.LINK_ACCOUNT_SITE, { siteId, ...source })
		: ipcAsync(IPC.LINK_MANUAL, { siteId, ...source }));

	function KinstaPanel({ site }) {
		const [state] = useKinstaState(site && site.id);
		if (!site) return null;
		return h('div', { className: 'KNConnect' },
			h(Title, { size: 'm', className: 'KNConnect_Title' }, 'Kinsta'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			!state
				? h(BusyNote, { busy: true }, 'Loading…')
				: state.link
					? h(LinkedView, { site, state })
					: h(SetupView, { state, submitLabel: `Link ${site.name}`, onSubmit: linkSite(site.id) }),
			state ? h(VersionFooter, { update: state.update }) : null);
	}

	// ---------------------------------------------------------------- compare & selective sync

	const formatSize = (bytes) => {
		if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	};
	const formatTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
	const describeSide = (side) => (side ? [formatSize(side.size), formatTime(side.mtime)].filter(Boolean).join(' · ') : '');

	const GROUPS = [
		['changed', 'Different on each side'],
		['local-only', 'Only in Local'],
		['remote-only', 'Only on Kinsta'],
	];
	const NEWER = { local: 'Newer in Local', remote: 'Newer on Kinsta', same: 'Same date' };
	const ROW_LIMIT = 200;

	function CompareRow({ entry, checked, onToggle }) {
		return h('label', { className: 'KNConnect_FileRow' },
			h('input', { type: 'checkbox', checked, onChange: onToggle }),
			h('span', { className: 'KNConnect_FilePath', title: entry.path }, entry.path, entry.type === 'symlink' ? ' (link)' : ''),
			entry.status === 'changed'
				? h('span', { className: 'KNConnect_FileMeta' },
					h('span', null, `Local: ${describeSide(entry.local)}`),
					h('span', null, `Kinsta: ${describeSide(entry.remote)}`),
					entry.newer ? h('span', { className: `KNConnect_Badge KNConnect_Badge--${entry.newer}` }, NEWER[entry.newer]) : null)
				: h('span', { className: 'KNConnect_FileMeta' }, describeSide(entry.status === 'local-only' ? entry.local : entry.remote)));
	}

	/**
	 * MagicSync-style comparison: lists files that differ between Local and Kinsta, lets you tick files, and
	 * pushes or pulls only those. A ticked file missing on the sending side is deleted on the receiving side.
	 */
	function CompareView({ site, activity }) {
		const [result, setResult] = useState(null);
		const [checksum, setChecksum] = useState(false);
		const [filter, setFilter] = useState('');
		const [selected, setSelected] = useState(() => new Set());
		const compareAction = useAction();
		const syncAction = useAction();

		const compare = () => compareAction.run(async () => {
			const res = await ipcAsync(IPC.COMPARE, { siteId: site.id, checksum });
			setResult(res);
			setSelected(new Set());
		});

		const entries = result ? result.entries : [];
		const needle = filter.trim().toLowerCase();
		const visible = needle ? entries.filter((e) => e.path.toLowerCase().includes(needle)) : entries;
		const toggle = (p) => setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(p)) next.delete(p);
			else next.add(p);
			return next;
		});
		const setGroup = (list, on) => setSelected((prev) => {
			const next = new Set(prev);
			list.forEach((e) => (on ? next.add(e.path) : next.delete(e.path)));
			return next;
		});

		const chosen = entries.filter((e) => selected.has(e.path));
		const count = (statuses) => chosen.filter((e) => statuses.includes(e.status)).length;

		const sync = async (direction) => {
			const send = direction === 'push' ? count(['changed', 'local-only']) : count(['changed', 'remote-only']);
			const remove = direction === 'push' ? count(['remote-only']) : count(['local-only']);
			const there = direction === 'push' ? 'on Kinsta' : 'in Local';
			await confirm({
				title: `${direction === 'push' ? 'Push' : 'Pull'} ${chosen.length} selected file${chosen.length === 1 ? '' : 's'}?`,
				message: h('div', null,
					send ? h('p', null, `${send} file${send === 1 ? '' : 's'} will be ${direction === 'push' ? 'uploaded to Kinsta' : 'downloaded to Local'}, replacing the copy ${there}.`) : null,
					remove ? h('p', null, `${remove} file${remove === 1 ? '' : 's'} that only exist${remove === 1 ? 's' : ''} ${there} will be deleted ${there}.`) : null,
					h('p', null, 'The database is not changed.')),
				buttonText: direction === 'push' ? 'Push' : 'Pull',
			});
			await syncAction.run(async () => {
				const fileList = chosen.map((e) => e.path);
				const options = direction === 'push' ? { fileList, purgeCache: true } : { fileList };
				await ipcAsync(direction === 'push' ? IPC.PUSH : IPC.PULL, { siteId: site.id, options });
				await compare();
			});
		};

		const busy = compareAction.busy || syncAction.busy || Boolean(activity);

		return h('div', { className: 'KNConnect_Compare' },
			h('p', { className: 'KNConnect_Intro' },
				'See which files differ between Local and Kinsta, then push or pull only the ones you pick. Nothing changes until you choose.'),
			h('div', { className: 'KNConnect_Actions KNConnect_Actions--Top' },
				h(PrimaryButton, { onClick: compare, disabled: busy }, compareAction.busy || activity === 'compare' ? 'Comparing…' : result ? 'Compare again' : 'Compare with Kinsta'),
				h(Checkbox, { label: 'Compare file contents (slower)', checked: checksum, onChange: (v) => setChecksum((p) => isChecked(v, p)) })),
			h(ErrorNote, { error: compareAction.error || syncAction.error }),
			result
				? h('div', null,
					h('p', { className: 'KNConnect_Summary', role: 'status' },
						entries.length === 0
							? 'Local and Kinsta have the same files.'
							: GROUPS.map(([key, label]) => `${entries.filter((e) => e.status === key).length} ${label.toLowerCase()}`).join(' · ')),
					entries.length
						? h(React.Fragment, null,
							h('div', { className: 'KNConnect_Filter' },
								h(TextInput, { value: filter, onChange: setFilter, placeholder: 'Filter by path, e.g. wp-content/themes' })),
							GROUPS.map(([key, label]) => {
								const list = visible.filter((e) => e.status === key);
								if (!list.length) return null;
								const allOn = list.every((e) => selected.has(e.path));
								return h('section', { key, className: 'KNConnect_Group' },
									h('label', { className: 'KNConnect_GroupHeader' },
										h('input', { type: 'checkbox', checked: allOn, onChange: () => setGroup(list, !allOn) }),
										h('span', null, `${label} (${list.length})`)),
									list.slice(0, ROW_LIMIT).map((entry) => h(CompareRow, {
										key: entry.path,
										entry,
										checked: selected.has(entry.path),
										onToggle: () => toggle(entry.path),
									})),
									list.length > ROW_LIMIT
										? h('p', { className: 'KNConnect_Help' }, `${list.length - ROW_LIMIT} more not shown. Narrow the list with the filter; the group checkbox still selects all ${list.length}.`)
										: null);
							}),
							h('div', { className: 'KNConnect_Actions KNConnect_SyncBar' },
								h('span', null, `${chosen.length} selected`),
								h(Button, { disabled: busy || !chosen.length, onClick: () => sync('pull') }, syncAction.busy && activity === 'pull' ? 'Pulling…' : 'Pull selected'),
								h(PrimaryButton, { disabled: busy || !chosen.length, onClick: () => sync('push') }, syncAction.busy && activity === 'push' ? 'Pushing…' : 'Push selected')))
						: null)
				: null);
	}

	// ---------------------------------------------------------------- pull to a new site

	/** Page behind Local's "Create a site → Pull from Kinsta" option. */
	function NewSitePage({ history }) {
		const [state] = useKinstaState(null);
		const [siteName, setSiteName] = useState('');
		const [nameTouched, setNameTouched] = useState(false);
		const [location, setLocation] = useState(null);
		const [started, setStarted] = useState(null);

		useEffect(() => {
			const name = siteName.trim();
			if (!name) {
				setLocation(null);
				return undefined;
			}
			const timer = setTimeout(() => {
				ipcAsync(IPC.NEW_SITE_LOCATION, name).then(setLocation).catch(() => setLocation(null));
			}, 200);
			return () => clearTimeout(timer);
		}, [siteName]);

		const onSiteSelected = (choice) => {
			if (!nameTouched) setSiteName(choice.siteName);
		};

		const submit = async (source) => {
			const res = await ipcAsync(IPC.PULL_NEW_SITE, { siteName: siteName.trim(), source });
			setStarted(res);
		};

		return h('div', { className: 'KNConnect KNConnect_NewSite' },
			h('div', { className: 'KNConnect_NewSiteHeader' },
				h(TextButton, { onClick: () => history.push('/main/create-site') }, '← Back'),
				h(Title, { size: 'l', className: 'KNConnect_Title' }, 'Pull from Kinsta')),
			h('p', { className: 'KNConnect_Intro' },
				'Creates a new Local site, then pulls the files and database of a Kinsta WordPress site into it. Your Kinsta site is not changed.'),
			state ? h(UpdateNotice, { update: state.update }) : null,
			started
				? h('div', { className: 'KNConnect_Success', role: 'status' },
					`Creating ${siteName.trim()} at ${started.domain}. Progress continues in the site's overlay.`)
				: h(React.Fragment, null,
					h(Field, {
						label: 'Local site name',
						help: location ? `${location.domain} · ${location.sitePath}` : 'Defaults to the Kinsta site\'s name.',
					}, h(TextInput, { value: siteName, onChange: (v) => { setNameTouched(true); setSiteName(v); }, placeholder: 'My Kinsta site' })),
					!state
						? h(BusyNote, { busy: true }, 'Loading…')
						: h(SetupView, {
							state,
							submitLabel: 'Create site & pull',
							canSubmit: Boolean(siteName.trim()),
							onSubmit: submit,
							onSiteSelected,
						})));
	}

	function HeaderButtons({ site }) {
		const [state] = useKinstaState(site && site.id);
		const [open, setOpen] = useState(null);
		if (!site || !state || !state.link) return null;
		const { link, activity } = state;
		const button = (direction) => h(Button, {
			key: direction,
			className: 'KNConnect_HeaderButton',
			disabled: Boolean(activity),
			onClick: () => setOpen(direction),
			title: `${DIRECTIONS[direction].button} (${linkTarget(link)})`,
		}, activity === direction ? `${DIRECTIONS[direction].gerund}…` : DIRECTIONS[direction].verb);

		return h('span', { className: 'KNConnect_HeaderButtons' },
			h('span', { className: 'KNConnect_HeaderLabel' }, 'Kinsta'),
			button('pull'),
			button('push'),
			open
				? h(FlyModal, { isOpen: true, contentLabel: DIRECTIONS[open].button, onRequestClose: () => setOpen(null) },
					h('div', { className: 'KNConnect KNConnect_Modal' },
						h(Title, { size: 'l', className: 'KNConnect_Title' }, DIRECTIONS[open].button),
						h('p', { className: 'KNConnect_Intro' }, open === 'push'
							? `${site.name} → ${linkTarget(link)}`
							: `${linkTarget(link)} → ${site.name}`),
						h(TransferForm, { direction: open, site, link, activity, inModal: true, onStarted: () => setOpen(null) })))
				: null);
	}

	return { KinstaPanel, HeaderButtons, TransferForm, CompareView, NewSitePage };
};
