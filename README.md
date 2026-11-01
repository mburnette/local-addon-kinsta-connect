# ConnectLocal for Kinsta

A [Local](https://localwp.com) add-on that connects Local to WordPress sites on [Kinsta](https://kinsta.com). It works the way Local Connect does for WP Engine and Flywheel. You can:

- **push** a site's files, database, or both to a Kinsta environment (live or staging);
- **pull** them back into an existing Local site;
- **pull a Kinsta site into a brand-new Local site**;
- **compare** files on both sides and push or pull only the ones you pick, like MagicSync.

Files move with rsync over SSH and the database with WP-CLI, the same tools Local Connect uses for WP Engine. The [Kinsta API](https://api-docs.kinsta.com) handles everything around the transfer: finding sites, reading SSH logins, backups and cache clearing.

| Step | WP Engine (built in) | ConnectLocal for Kinsta |
| --- | --- | --- |
| Auth | WP Engine account + Local's SSH key registered via CAPI | A Kinsta API key. Kinsta's API can't register SSH keys, so Local logs in with its own key if you've added it in MyKinsta. Otherwise it uses the environment's SFTP/SSH password, fetched from the API for each transfer and never stored. |
| Finding the site | CAPI install list | `GET /sites` lists every site and environment in the key's company. `ssh/config` gives each environment's SSH host, port and username. |
| Backup | CAPI backup before push | `POST /sites/environments/{id}/manual-backups`, polled with `GET /operations/{id}` (on by default) |
| Files | Local's bundled `rsync` over SSH, `--delete`, excludes `wp-config.php` | Same binaries, same flags. Also excludes Kinsta's must-use plugin, cache drop-ins and any other WordPress install in a subfolder. Must-use plugins that exist only on one side are never deleted. |
| Database | `wp db export` backup → `wp db reset` → import → `search-replace //local //remote` → match table prefix | Same, plus collation fixes between MySQL and MariaDB, and automatic restore if an import fails |
| Pull | rsync down, export remote DB, import, `search-replace //remote //local` | Same. It also replaces the environment's other domains, such as its temporary `*.kinsta.cloud` address. |
| Cache | Purge CDN/object/page cache | `POST /sites/tools/clear-cache`, plus `wp cache flush` and `wp kinsta cache purge --all` over SSH |
| Pull to new site | "Create a site → Pull from WP Engine" | "Create a site → Pull from Kinsta". It checks the connection first, creates the site with Local's `addSite` service, links it, then pulls. |
| MagicSync | rsync dry run, itemized changes, file tree with checkboxes | rsync dry runs in both directions, merged into one list with both sides' size and date. Ticked files move with `--files-from`. |

## Requirements

- Local 6 or newer. Developed against **Local 10.1.2 on macOS**.
- A Kinsta **API key** (recommended). In MyKinsta, open **your name → Company settings → API Keys** and click **Create API Key** ([Kinsta's guide](https://kinsta.com/docs/kinsta-api/)).
  - Company owners, administrators and developers can create keys. A key has the same access as the user who creates it.
  - Without a key, you can still link a site with the SFTP/SSH details shown in MyKinsta under **Sites → your site → Info**.
- WP-CLI and rsync on the server. Kinsta installs WP-CLI on every server. If `wp` is missing, the add-on installs its own copy.

## Install

### From source (development)

```bash
npm install
```

```bash
npm run install-addon
```

This symlinks the folder into Local's add-ons directory (`~/Library/Application Support/Local/addons` on macOS) and enables it. **Restart Local** to load it. To remove it, run `npm run install-addon -- --remove`.

This add-on is separate from ConnectLocal for Cloudways and ConnectLocal for Bluehost, and can be installed next to them: package names, IPC channels, CSS classes, storage folders and ignore files are all distinct.

### From a release

Download the `.tgz` from the [latest release](../../releases/latest). In Local, go to **Add-ons → Install from disk**, choose the file, enable the add-on and restart Local.

### Updates

The add-on checks this repository's releases when Local starts and every 12 hours after that. You can also check right away from **Check for updates** at the bottom of the add-on's panel. When a new version is out, the panel shows an **Update** button. It installs the update through Local's own add-on installer, then offers to restart Local. Your linked sites and saved credentials are kept.

To build a package yourself, run `npm run package`, or use `npm run release -- patch --dry-run` (see [RELEASING.md](RELEASING.md)).

## Use

1. Open a site in Local and go to **Tools → Kinsta**.
2. Connect in one of two ways:
   - **Kinsta API (recommended):** paste your API key, pick a site and environment (grouped by site, live first) and click **Link**. The add-on then:
     - reads the environment's SSH host, port and username;
     - turns SFTP/SSH on for the environment if it is off;
     - logs in with Local's SSH key if MyKinsta has it, or else with the environment's SFTP/SSH password from the API;
     - finds the WordPress webroot (`public/` in the site folder, or the web root set in MyKinsta).
   - **SFTP/SSH details:** enter the host, port, username and password (or use Local's key) shown in MyKinsta under **Sites → your site → Info**. Each environment has its own port.
3. To have Local log in with its own key instead of the password, copy the public key shown in the panel and add it in MyKinsta under **your name → User settings → SSH keys**. Then link the site again.
4. Push or pull from the panel's **Push to Kinsta** / **Pull from Kinsta** tabs. Once the site is linked, you can also use the **Kinsta: Pull / Push** buttons in the site header.
   - Push options: Files and/or Database; create a Kinsta backup first (API links, on by default); delete files on Kinsta that aren't in Local (on by default, like WP Engine); clear Kinsta caches afterwards.
   - Pull options: Files and/or Database; back up the Local database first; delete Local files that aren't on Kinsta (on by default).
   - Every pull moves the Local files it replaces or deletes into `app/kinsta-backups/pull-<time>/` instead of discarding them. The last 3 are kept.

Progress appears in Local's site overlay. When the transfer finishes, a banner reports success or the error.

### Pull a Kinsta site into a new Local site

1. Click **+** (Create a site) in Local and choose **Pull from Kinsta**.
2. Pick the site and environment, or enter SFTP/SSH details. Name the Local site; it defaults to the Kinsta site's name.
3. Click **Create site & pull**. The connection is checked **first**, so a wrong login never leaves an empty site behind.

### Compare & sync files (selective sync)

Go to **Tools → Kinsta → Compare & sync files** and click **Compare with Kinsta**. Nothing changes until you choose files. Differing files are listed under **Different on each side**, **Only in Local** and **Only on Kinsta**. Tick files, then click **Push selected** or **Pull selected**. A ticked file that exists only on the receiving side is deleted there. The database is never touched.

### What a database push does

1. Exports the Local database and rewrites MySQL 8 `utf8mb4_0900_*` collations to ones MariaDB accepts.
2. On Kinsta, saves the current database to `local-backup-before-push.sql` in a private folder for this site, `.kinsta-connect/<site folder>`, outside the webroot (inside the environment's `private/` folder when it has one; one per site, so a second WordPress in a subfolder of `public/` never shares it). It also reads the current `home` URL and `table_prefix`. This is in addition to the Kinsta backup.
3. Uploads the dump to that folder, then runs `wp db reset` and `wp db import`. If the import fails, it restores the backup automatically. The uploaded dump is always deleted afterwards.
   - When the database also holds another site's tables (a different table prefix, such as a second WordPress in a subfolder), it drops only this site's tables instead of resetting the whole database, and the backup holds only those tables. If the Local site's table prefix would overwrite the other site's tables, the push stops before changing anything.
4. Sets `table_prefix` to match Local if the two differ.
5. Runs `wp search-replace` across all tables (only this site's prefix in a shared database; `--precise`, `guid` skipped) from `//site.local` to the Kinsta URL, including the JSON-escaped form, plus `http://` → `https://` when the Kinsta site uses HTTPS.

### What a database pull does

1. On Kinsta, exports the database with `--single-transaction` (the live site isn't locked), downloads it and deletes the export.
2. Makes the dump importable by Local's MySQL. It removes the MariaDB "sandbox mode" line and rewrites `uca1400` collations.
3. Saves the Local database to `app/sql/local-backup-before-pull.sql` (optional).
4. Imports through Local's own WP-CLI service. If the import fails, it restores the backup.
5. Matches Local's `table_prefix` to Kinsta's, then replaces the Kinsta URL and the environment's other domains (such as `shop.kinsta.cloud` or `stg-shop-staging.kinsta.cloud`) with the Local URL.

### What is never transferred

These are excluded in both directions, and excluded paths are also protected from `--delete`:

- Environment config: `wp-config.php`, `.htaccess`, `.user.ini`, `php.ini`, `wp-cli.yml`
- Kinsta's must-use plugin: `mu-plugins/kinsta-mu-plugins.php` and `mu-plugins/kinsta-mu-plugins/`
- Caches and drop-ins: `object-cache.php` (Kinsta's Redis add-on), `advanced-cache.php`, `wp-content/cache/`
- Server-specific state: `wp-content/jetpack-waf/`, `wp-content/upgrade/`, `wp-content/upgrade-temp-backup/`
- Migration-plugin backups: `wp-content/ai1wm-backups/`, `wp-content/updraft/`
- Other WordPress installs in subfolders of the webroot
- VCS and tool binaries, root-level `*.sql` dumps, Local's helper files

Must-use plugins that exist only on the receiving side are never deleted.

To skip more, add rsync patterns (one per line) to `app/public/.kinsta-push-ignore` or `.kinsta-pull-ignore`. These work like `.wpe-push-ignore` and `.wpe-pull-ignore`.

### Themes and plugins symlinked from elsewhere

A theme or plugin that you develop in another folder and symlink into the Local site (for example `wp-content/themes/mytheme → ~/code/mytheme`) is **pushed as real files**, because the server has no such folder to point to. It is **never pulled into**: a pull leaves the symlink and the folder it points to untouched. Symlinks within the site stay symlinks, and broken symlinks are skipped (and logged).

## Security notes

- **Secrets:** the API key and any typed SFTP/SSH password are encrypted with Electron `safeStorage` (Keychain on macOS, DPAPI on Windows). They are stored in `<Local data>/kinsta-connect/settings.json` and never sent to the renderer.
- **Passwords from the API:** when Local's key isn't in MyKinsta, the environment's password is fetched from the API at the start of each push, pull or comparison, and kept only in memory. It goes to `ssh` through `SSH_ASKPASS` and an environment variable, never in argv or on disk.
- **SSH key and known hosts:** the add-on keeps its own RSA key in `<Local data>/kinsta-connect/ssh/`, separate from Local's WP Engine key and from the other ConnectLocal add-ons' keys. It also keeps its own `known_hosts` file, which pins each server's host key on first connect.
- **What the add-on changes on Kinsta:**
  - it turns SFTP/SSH on for an environment you link, if it was off;
  - it creates manual backups before a push (if ticked);
  - it creates a private `.kinsta-connect/<site folder>` folder for dumps and backups;
  - only when the server has no WP-CLI, it downloads `wp-cli.phar` into that folder.
- **Shared SSH connection:** on macOS and Linux, each push, pull or comparison logs in once and runs every command over that connection. Its control socket is `/tmp/knc-<hash>`, usable only by your user.

## Verified on a live account

Tested on 2026-10-31 against a real Kinsta site (a premium Live environment and a standard Staging one, PHP 8.5, WordPress 7.1.4, MariaDB 11.4, WP-CLI 2.12, rsync 3.2.7). The tests drove the add-on's own main process with Local's side stubbed (site data, database dump and WP-CLI); the Kinsta API and SSH were real.

- **Account and listing:** `GET /validate` returned the company; `GET /sites` returned the site with its environment, domains and SSH port.
- **Linking with Local's key** (1.5 s), and **with a key MyKinsta doesn't have** (4.4 s): the key was refused and the add-on logged in with the password from the API, without storing it.
- **Server layout:** the SSH user's home is `/www/<site>_<n>`, with `public/` (the webroot, including `wp-config.php`) and `private/`. The API's `web_root` is that absolute path. Kinsta's must-use plugin is `mu-plugins/kinsta-mu-plugins.php` plus its folder, and `wp kinsta cache` exists.
- **Pull** (3,781 files, 114 MB, plus the database, 8 s): the must-use plugin and `wp-config.php` stayed on the server, the `uca1400` collations were rewritten, and the URLs were replaced. A comparison afterwards found no differences.
- **Push** of a new file and a changed site title (11.5 s): a manual backup appeared in MyKinsta first, the new title showed on the live page straight away, `home` and `siteurl` were correct, no Local URL was left in the database, and the must-use plugin and `wp-config.php` were untouched.
- **Selective sync** over the password login: the comparison found the one changed file, and the selective push deleted it on Kinsta.
- **Staging:** it shares Live's IP, SSH username and folder path and differs only in its SSH port (and its `stg-<site>-staging.kinsta.cloud` domain), so the port is what tells them apart. Linking, a pull, and a push of a file and a new title (with a backup on staging first) all worked. Live's title and files didn't change, and the staging database ended up with only its own URL.
- **Cache:** the API's cache clear finishes in about 6 seconds, and the push waits for it. Kinsta's edge (Cloudflare) can keep serving a copy of a changed static file for up to a minute after that.

## Limitations and what is not verified

- **Not yet run inside Local itself.** The live tests stubbed Local's database and WP-CLI services. Try the Tools panel, header buttons and "Pull from Kinsta" wizard in a running Local before relying on them.
- **A failed backup:** how `/operations` reports a backup that fails has not been seen yet; the push treats any error as a stop.
- **Manual backups are limited.** Kinsta keeps a fixed number of manual backups per environment. If it refuses one, the push stops before changing anything; delete an old backup in MyKinsta or untick the backup option.
- **Password-protected sites:** `wp kinsta cache purge` needs to reach the site over HTTP, so on a password-protected environment only the API cache clear and `wp cache flush` take effect.
- **IP allowlists:** if the environment's SFTP/SSH allowlist is on, add your IP in MyKinsta first.
- **Multisite:** the domain columns in `wp_blogs` and `wp_site` are not rewritten.
- **Windows:** password logins aren't supported (add Local's key in MyKinsta), and nothing has been tested on Windows.

## Development

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run lint
```

- `npm test` runs the unit, main-process and renderer tests. They cover:
  - the API client against the spec's response shapes (validation, sites, SSH config, password, backups, operations, cache, rate limiting);
  - the linking flow (key first, then the API password, then a clear error), with the API faked;
  - the remote discovery script on a Kinsta-like folder;
  - dump normalization, URL replacement pairs, rsync itemize parsing and merging;
  - encrypted storage;
  - the React UI mounted in jsdom with the real `@getflywheel/local-components`.
- `npm run test:e2e` starts an unprivileged `sshd` on 127.0.0.1 with a fake `wp` and a Kinsta-like site folder. Through Local's bundled `rsync`/`ssh`, it runs:
  - a backup, files + database push and cache clear (checking that it logs in only once);
  - a full pull;
  - a comparison, a selective push and a selective pull;
  - a checksum compare.

```
lib/
  main.js                 add-on main process: IPC handlers, account and linking flow
  main/KinstaApi.js       Kinsta API client (validate, sites, SSH config and password, backups, operations, cache)
  main/SyncService.js     push and pull orchestration (discovery, files, database, search-replace, cache)
  main/transport.js       rsync/ssh runner using Local's bundled binaries, key or password auth
  main/sshKey.js          RSA key pair in OpenSSH format
  main/store.js           settings + encrypted secrets
  main/updater.js         checks GitHub releases and installs updates through Local's add-on installer
  renderer.js             hooks: Tools → Kinsta tab, header pull/push buttons, create-site option, stylesheet
  renderer/components.js  React UI (plain React.createElement, no build step)
```

### Kinsta API endpoints used

| Purpose | Endpoint |
| --- | --- |
| Auth | `Authorization: Bearer <API key>` on every call; `GET /validate` returns the key's company |
| Sites + environments | `GET /sites?company=…&include_environments=true`, `GET /sites/{site_id}/environments` |
| SSH login | `GET /sites/{site_id}/environments/{env_id}/ssh/config` |
| SSH on/off | `GET /sites/environments/{env_id}/ssh/get-status`, `POST …/ssh/set-status` |
| SSH password | `GET /sites/environments/{env_id}/ssh/password` |
| Backup | `POST /sites/environments/{env_id}/manual-backups` |
| Cache | `POST /sites/tools/clear-cache` |
| Operations | `GET /operations/{operation_id}` (202 running, 200 done) |

The base URL is `https://api.kinsta.com/v2`. Kinsta allows 120 requests per minute per company; the add-on makes a handful per link or transfer.

## Releasing

See [RELEASING.md](RELEASING.md). In short: commit to `main`, then run `npm run release -- patch` (or `minor`/`major`).
