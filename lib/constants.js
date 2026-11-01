'use strict';

/** IPC channels shared by the main and renderer halves of the add-on. */
const IPC = {
	GET_STATE: 'kinstaConnect:getState',
	CONNECT_ACCOUNT: 'kinstaConnect:connectAccount',
	DISCONNECT_ACCOUNT: 'kinstaConnect:disconnectAccount',
	LIST_SITES: 'kinstaConnect:listSites',
	LINK_ACCOUNT_SITE: 'kinstaConnect:linkAccountSite',
	LINK_MANUAL: 'kinstaConnect:linkManual',
	UNLINK_SITE: 'kinstaConnect:unlinkSite',
	TEST_CONNECTION: 'kinstaConnect:testConnection',
	PUSH: 'kinstaConnect:push',
	PULL: 'kinstaConnect:pull',
	COMPARE: 'kinstaConnect:compare',
	NEW_SITE_LOCATION: 'kinstaConnect:newSiteLocation',
	PULL_NEW_SITE: 'kinstaConnect:pullNewSite',
	/** main -> renderer: (progressId, message) while linking. */
	LINK_PROGRESS: 'kinstaConnect:linkProgress',
	GET_PUBLIC_KEY: 'kinstaConnect:getPublicKey',
	CHECK_UPDATE: 'kinstaConnect:checkUpdate',
	INSTALL_UPDATE: 'kinstaConnect:installUpdate',
	RESTART_LOCAL: 'kinstaConnect:restartLocal',
	/** main -> renderer broadcast whenever stored state changes. */
	STATE_CHANGED: 'kinstaConnect:stateChanged',
};

const KINSTA_API_BASE = 'https://api.kinsta.com/v2';

/** Where the official WP-CLI build is downloaded from when a server has no `wp` command. */
const WP_CLI_PHAR_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';

/**
 * Paths never synced in either direction. rsync --exclude also protects them from --delete, so each side keeps
 * its own environment files: Kinsta keeps wp-config.php (its DB credentials and cache settings), and Local never
 * receives Kinsta's must-use plugin or Redis drop-in, which would break the local site.
 */
const SYNC_EXCLUDES = [
	// Environment-specific config
	'/wp-config.php',
	'/.htaccess',
	'/.user.ini',
	'/php.ini',
	'/wp-cli.yml',
	// Kinsta's must-use plugin (cache purging, CDN, MyKinsta integration), installed and updated by the platform
	'wp-content/mu-plugins/kinsta-mu-plugins.php',
	'wp-content/mu-plugins/kinsta-mu-plugins/',
	// Server-specific state: Jetpack's firewall rules hold absolute server paths; upgrade/ is WordPress scratch space
	'wp-content/jetpack-waf/',
	'wp-content/upgrade/',
	'wp-content/upgrade-temp-backup/',
	// Caching drop-ins (the Redis add-on's object cache) and cache output
	'wp-content/object-cache.php',
	'wp-content/advanced-cache.php',
	'wp-content/cache/',
	// Site backups made by migration plugins: often gigabytes, and never wanted on the other side
	'wp-content/ai1wm-backups/',
	'wp-content/updraft/',
	// VCS and tooling
	'.git/',
	'.svn/',
	'node_modules/.bin/',
	'vendor/bin/',
	'.DS_Store',
	// Stray dumps in the webroot and Local helpers
	'/*.sql',
	'/*.sql.gz',
	'wp-content/mysql.sql',
	'local-phpinfo.php',
	'local-xdebuginfo.php',
	'wp-content/mu-plugins/local-by-flywheel-demo-urls.php',
	'wp-content/mu-plugins/local-by-flywheel-live-link-helper.php',
	// Ignore files for other hosts and for this add-on
	'.wpe-push-ignore',
	'.wpe-pull-ignore',
	'.cloudways-push-ignore',
	'.cloudways-pull-ignore',
	'.bluehost-push-ignore',
	'.bluehost-pull-ignore',
	'.kinsta-push-ignore',
	'.kinsta-pull-ignore',
];

/**
 * rsync filter rules added after the excludes. Must-use plugins that exist only on the receiving side are never
 * deleted: hosts install their own there, and a push from a Local site without them must not remove them.
 */
const SYNC_PROTECT = [
	'--filter=P wp-content/mu-plugins/*',
];

/** Optional per-site ignore files in the site's webroot, same idea as .wpe-push-ignore / .wpe-pull-ignore. */
const IGNORE_FILES = {
	push: '.kinsta-push-ignore',
	pull: '.kinsta-pull-ignore',
};

module.exports = {
	IPC,
	KINSTA_API_BASE,
	WP_CLI_PHAR_URL,
	SYNC_EXCLUDES,
	SYNC_PROTECT,
	IGNORE_FILES,
};
