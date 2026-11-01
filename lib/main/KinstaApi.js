'use strict';

const { KINSTA_API_BASE } = require('../constants');

class KinstaApiError extends Error {
	constructor(message, status, body) {
		super(message);
		this.name = 'KinstaApiError';
		this.status = status;
		this.body = body;
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls the most useful human-readable message out of a Kinsta error body. */
function errorMessageFrom(body, status) {
	if (body && typeof body === 'object') {
		if (typeof body.message === 'string' && body.message) return body.message;
		if (typeof body.error === 'string' && body.error) return body.error;
		if (Array.isArray(body.errors) && body.errors.length) {
			return body.errors.map((e) => (typeof e === 'string' ? e : e && (e.message || e.code))).filter(Boolean).join(' ');
		}
	}
	return `Kinsta API request failed (HTTP ${status})`;
}

/**
 * Thin client for the Kinsta public API (https://api-docs.kinsta.com, OpenAPI spec 1.116). An API key, created under
 * MyKinsta → Company settings → API Keys, is sent as a bearer token on every request; `GET /validate` tells which
 * company it belongs to. The API lists sites and their environments with SSH details, returns the SFTP/SSH password,
 * takes manual backups and clears caches. Files and the database still move over SSH. There is no endpoint for SSH
 * keys: those are added by hand in MyKinsta.
 */
class KinstaApi {
	constructor({ apiKey, companyId = null, fetchImpl = globalThis.fetch, base = KINSTA_API_BASE, logger = console }) {
		if (!apiKey) throw new KinstaApiError('A Kinsta API key is required.', 0);
		this._apiKey = apiKey;
		this._companyId = companyId;
		this._fetch = fetchImpl;
		this._base = base;
		this._logger = logger;
	}

	/** Checks the key and learns its company: { name, expiresAt, companyId }. */
	async validate() {
		const { data } = await this.request('GET', '/validate');
		if (!data.company) throw new KinstaApiError('Kinsta did not say which company this API key belongs to.', 200, data);
		if (data.status && data.status !== 'active') {
			throw new KinstaApiError(`This API key is ${data.status}. Create a new one under MyKinsta → Company settings → API Keys.`, 200, data);
		}
		this._companyId = data.company;
		return { name: data.name || null, expiresAt: data.expires_at || null, companyId: data.company };
	}

	/** The company's sites, each with its environments (SSH IP and port, domains, web root). */
	async listSites() {
		if (!this._companyId) await this.validate();
		const { data } = await this.request('GET', '/sites', { query: { company: this._companyId, include_environments: true } });
		return (data.company && data.company.sites) || [];
	}

	async getEnvironments(siteId) {
		const { data } = await this.request('GET', `/sites/${encodeURIComponent(siteId)}/environments`);
		return (data.site && data.site.environments) || [];
	}

	/** SSH login for one environment: { host, port, username }. The username is not part of the environment listing. */
	async getSshConfig(siteId, envId) {
		const { data } = await this.request('GET', `/sites/${encodeURIComponent(siteId)}/environments/${encodeURIComponent(envId)}/ssh/config`);
		const container = (data.site && data.site.environment && data.site.environment.activeContainer) || {};
		return {
			host: data.host || (container.loadBalancer && container.loadBalancer.extIP) || null,
			port: Number(data.port || container.lxdSshPort) || null,
			username: data.user || (data.site && data.site.usr) || null,
		};
	}

	async getSshEnabled(envId) {
		const { data } = await this.request('GET', `/sites/environments/${encodeURIComponent(envId)}/ssh/get-status`);
		return Boolean(data.environment && data.environment.active_container && data.environment.active_container.is_ssh_enabled);
	}

	/** Same switch as MyKinsta → Info → SFTP/SSH → Enable. */
	async enableSsh(envId) {
		await this.request('POST', `/sites/environments/${encodeURIComponent(envId)}/ssh/set-status`, { json: { is_enabled: true } });
	}

	/** The environment's current SFTP/SSH password. Fetched for each connection and never stored. */
	async getSshPassword(envId) {
		const { data } = await this.request('GET', `/sites/environments/${encodeURIComponent(envId)}/ssh/password`);
		const password = data.environment && data.environment.sftp_password;
		if (!password) throw new KinstaApiError('Kinsta did not return an SFTP/SSH password for this environment.', 200, data);
		return password;
	}

	/** Starts a manual backup of an environment. Resolves the operation id. */
	async createBackup(envId, tag) {
		const { data } = await this.request('POST', `/sites/environments/${encodeURIComponent(envId)}/manual-backups`, { json: { tag } });
		return data.operation_id || null;
	}

	/** Clears the environment's site cache (the same as MyKinsta → Caching → Clear cache). Resolves the operation id. */
	async clearCache(envId) {
		const { data } = await this.request('POST', '/sites/tools/clear-cache', { json: { environment_id: envId } });
		return data.operation_id || null;
	}

	/** 'done' (HTTP 200), 'running' (202) or 'unknown' (404: not visible yet, expired, or not ours). Throws on failure. */
	async getOperation(operationId) {
		try {
			// Operation ids look like "backups:add-manual-<uuid>"; a colon is valid in a path and is sent as is.
			const { status } = await this.request('GET', `/operations/${encodeURIComponent(operationId).replace(/%3A/gi, ':')}`);
			return status === 202 ? 'running' : 'done';
		} catch (e) {
			if (e.status === 404) return 'unknown';
			throw e;
		}
	}

	/**
	 * Polls an operation until Kinsta reports it finished. A new operation can briefly be unknown to /operations, so
	 * 404s are tolerated for `unknownGraceMs`; after that the operation is treated as untrackable and null is returned.
	 */
	async waitForOperation(operationId, { timeoutMs = 15 * 60 * 1000, intervalMs = 5000, unknownGraceMs = 30 * 1000 } = {}) {
		if (!operationId) return null;
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const state = await this.getOperation(operationId);
			if (state === 'done') return operationId;
			if (state === 'unknown' && Date.now() - started >= unknownGraceMs) {
				this._logger.warn(`Cannot track Kinsta operation ${operationId}`);
				return null;
			}
			await sleep(intervalMs);
		}
		throw new KinstaApiError(`Timed out waiting for Kinsta operation ${operationId}.`, 0);
	}

	async request(method, path, { query, json } = {}, attempt = 0) {
		const url = new URL(`${this._base}${path}`);
		if (query) {
			Object.entries(query).forEach(([k, v]) => {
				if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
			});
		}
		const headers = { Authorization: `Bearer ${this._apiKey}`, Accept: 'application/json' };
		let body;
		if (json) {
			headers['Content-Type'] = 'application/json';
			body = JSON.stringify(json);
		}
		const res = await this._fetch(url.toString(), { method, headers, body });
		const data = await res.json().catch(() => null);
		if (res.status === 429 && attempt < 4) {
			const retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 2 ** attempt * 5;
			this._logger.warn(`Kinsta API rate limited; retrying in ${retryAfter}s`);
			await sleep(retryAfter * 1000);
			return this.request(method, path, { query, json }, attempt + 1);
		}
		if (res.status === 401) {
			throw new KinstaApiError('Kinsta rejected this API key. It may have expired or been revoked; create a new one under '
				+ 'MyKinsta → Company settings → API Keys.', 401, data);
		}
		if (res.status === 403) {
			throw new KinstaApiError(`This API key isn't allowed to ${method} ${path}. Use a key with access to the company's `
				+ 'sites (Company or Site administrator).', 403, data);
		}
		if (!res.ok) throw new KinstaApiError(errorMessageFrom(data, res.status), res.status, data);
		return { status: res.status, data: data || {} };
	}
}

module.exports = { KinstaApi, KinstaApiError, errorMessageFrom };
