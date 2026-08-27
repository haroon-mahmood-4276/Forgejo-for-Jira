import crypto from 'crypto';
import { kvs, WhereConditions } from '@forge/kvs';

/**
 * Every piece of persistent state this app owns lives here.
 *
 * Two storage flavours are in play and the split matters:
 *
 * - `kvs.set` / `kvs.get` store plain values. They are the only ones that can be
 *   *listed* with `kvs.query()`, which is how the admin page enumerates
 *   connections and repositories.
 * - `kvs.setSecret` / `kvs.getSecret` store encrypted values. They cannot be
 *   listed, and they are the only acceptable home for client secrets, OAuth
 *   tokens and webhook signing secrets.
 *
 * So each connection is stored twice: a public record describing it, and a
 * secret record holding its credentials. Nothing secret is ever written into the
 * public record.
 */

// --- Key builders -----------------------------------------------------------
// Prefixes are chosen so that no prefix is a prefix of another one. `conn:` must
// not match `conn-secret:` when we run a beginsWith query, hence the hyphen.

const CONNECTION_PREFIX = 'conn:';
const REPO_PREFIX = 'repo:';

const connectionKey = (id) => `${CONNECTION_PREFIX}${id}`;
const connectionSecretKey = (id) => `conn-secret:${id}`;
const connectionTokenKey = (id) => `conn-token:${id}`;
const repoKey = (connectionId, repoId) => `${REPO_PREFIX}${connectionId}:${repoId}`;
const oauthStateKey = (state) => `oauth-state:${state}`;

/** The project settings page stores only a pointer to a site-level connection. */
const projectLinkKey = (projectKey) => `project-link:${projectKey}`;

// --- Identifier and secret generation ---------------------------------------

/**
 * Connection identifiers appear inside the webhook URL we hand to the customer,
 * so they must be unguessable as well as unique: knowing a connection ID is one
 * of the two things needed to aim a delivery at this installation.
 */
export function newConnectionId() {
    return crypto.randomBytes(12).toString('hex');
}

/**
 * The webhook signing secret.
 *
 * This is generated per connection rather than read from a Forge environment
 * variable. Environment variables are set by the app *developer* at deploy time
 * and are identical across every installation, so using one would mean every
 * customer of this app shared a single signing key - and would also mean no
 * customer could ever set their own.
 */
export function newWebhookSecret() {
    return crypto.randomBytes(32).toString('hex');
}

// --- Connections ------------------------------------------------------------

/**
 * @typedef {object} ConnectionRecord
 * @property {string} id                Unguessable connection identifier.
 * @property {string} name              Display name chosen by the admin.
 * @property {string} instanceUrl       Normalised Forgejo base URL.
 * @property {string} clientId          OAuth application client ID (not secret).
 * @property {number} createdAt
 * @property {number} [connectedAt]     When OAuth last succeeded.
 * @property {string} [username]        Forgejo account that approved access.
 */

export async function saveConnection(connection) {
    await kvs.set(connectionKey(connection.id), connection);
}

export async function getConnection(id) {
    if (!id) return undefined;
    return kvs.get(connectionKey(id));
}

/**
 * List every connection in this installation.
 *
 * `kvs.query()` pages, so we follow the cursor to completion. A site is not
 * expected to have many Forgejo instances, so reading them all is cheap.
 */
export async function listConnections() {
    const connections = [];
    let cursor;

    do {
        let query = kvs
            .query()
            .where('key', WhereConditions.beginsWith(CONNECTION_PREFIX))
            .limit(50);

        if (cursor) query = query.cursor(cursor);

        const page = await query.getMany();
        connections.push(...page.results.map((row) => row.value));
        cursor = page.nextCursor;
    } while (cursor);

    return connections.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/**
 * Remove a connection and everything derived from it. Repositories are deleted
 * too, otherwise they would linger as unreachable records pointing at a
 * connection whose credentials no longer exist.
 */
export async function deleteConnection(id) {
    const repos = await listRepositories(id);
    for (const repo of repos) {
        await kvs.delete(repoKey(id, repo.repoId));
    }

    await kvs.deleteSecret(connectionTokenKey(id));
    await kvs.deleteSecret(connectionSecretKey(id));
    await kvs.delete(connectionKey(id));
}

// --- Connection secrets -----------------------------------------------------

/**
 * @typedef {object} ConnectionSecrets
 * @property {string} clientSecret     OAuth application client secret.
 * @property {string} webhookSecret    HMAC key shared with Forgejo webhooks.
 */

export async function saveConnectionSecrets(id, secrets) {
    await kvs.setSecret(connectionSecretKey(id), secrets);
}

export async function getConnectionSecrets(id) {
    if (!id) return undefined;
    return kvs.getSecret(connectionSecretKey(id));
}

// --- OAuth tokens -----------------------------------------------------------

export async function saveToken(connectionId, token) {
    await kvs.setSecret(connectionTokenKey(connectionId), token);
}

export async function getToken(connectionId) {
    if (!connectionId) return undefined;
    return kvs.getSecret(connectionTokenKey(connectionId));
}

export async function deleteToken(connectionId) {
    await kvs.deleteSecret(connectionTokenKey(connectionId));
}

// --- Repositories -----------------------------------------------------------

/**
 * @typedef {object} RepoRecord
 * @property {string} connectionId
 * @property {string} repoId       Forgejo's numeric repository ID, as a string.
 * @property {string} fullName     "owner/name".
 * @property {string} owner
 * @property {string} name
 * @property {string} htmlUrl
 * @property {number} [hookId]     ID of the webhook we created on Forgejo.
 * @property {number} addedAt
 * @property {object} [backfill]   Progress record, see backfill.js.
 */

export async function saveRepository(repo) {
    await kvs.set(repoKey(repo.connectionId, repo.repoId), repo);
}

export async function getRepository(connectionId, repoId) {
    return kvs.get(repoKey(connectionId, String(repoId)));
}

export async function deleteRepository(connectionId, repoId) {
    await kvs.delete(repoKey(connectionId, String(repoId)));
}

/**
 * List connected repositories, optionally narrowed to one connection.
 *
 * Passing a connection ID narrows the key prefix, so the query reads only that
 * connection's repositories instead of everything in the installation.
 */
export async function listRepositories(connectionId) {
    const prefix = connectionId ? `${REPO_PREFIX}${connectionId}:` : REPO_PREFIX;
    const repos = [];
    let cursor;

    do {
        let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(50);
        if (cursor) query = query.cursor(cursor);

        const page = await query.getMany();
        repos.push(...page.results.map((row) => row.value));
        cursor = page.nextCursor;
    } while (cursor);

    return repos.sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
}

// --- Pending OAuth authorizations -------------------------------------------

/**
 * Authorization attempts are short lived. Storing them lets the stateless OAuth
 * callback recover which connection it belongs to and which PKCE verifier to
 * present, without trusting anything in the callback URL except the state value.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

export async function savePendingState(state, data) {
    await kvs.setSecret(oauthStateKey(state), { ...data, expiresAt: Date.now() + STATE_TTL_MS });
}

/**
 * Read a pending authorization exactly once. Deleting on read means an
 * intercepted callback URL cannot be replayed.
 */
export async function consumePendingState(state) {
    if (!state) return undefined;

    const pending = await kvs.getSecret(oauthStateKey(state));
    if (!pending) return undefined;

    await kvs.deleteSecret(oauthStateKey(state));

    if (!pending.expiresAt || pending.expiresAt < Date.now()) return undefined;

    return pending;
}

// --- Project links ----------------------------------------------------------

/**
 * The project settings page is informational: development information is
 * site-wide and matched by issue key, so a project does not "own" a connection.
 * We still record which connection a project admin considers theirs, so the page
 * can show the right instance and the right onboarding state.
 */
export async function saveProjectLink(projectKey, connectionId) {
    await kvs.set(projectLinkKey(projectKey), { projectKey, connectionId, updatedAt: Date.now() });
}

export async function getProjectLink(projectKey) {
    if (!projectKey) return undefined;
    return kvs.get(projectLinkKey(projectKey));
}
