import { refreshAccessToken, toTokenRecord } from './forgejo-oauth.js';
import { getConnection, getConnectionSecrets, getToken, saveToken } from './storage.js';

/**
 * A thin client for Forgejo's REST API (`/api/v1`).
 *
 * Responsibilities kept here on purpose:
 *
 * - Attaching the stored OAuth token, and transparently refreshing it. Forgejo
 *   access tokens last about an hour, which is shorter than a large backfill,
 *   so anything that talks to Forgejo has to be able to refresh mid-run.
 * - Paging. Forgejo returns fixed-size pages with the total in the
 *   `X-Total-Count` header; callers work one page at a time so a single Forge
 *   invocation never tries to read a whole repository's history.
 * - Managing the repository webhook, so a customer never has to paste a URL and
 *   a secret into Forgejo by hand.
 */

/** Forgejo's own page-size ceiling is instance-configurable; 50 is safely under every default. */
export const PAGE_SIZE = 50;

/**
 * The webhook events this app knows how to handle. Registering only these keeps
 * Forgejo from delivering (and the app from paying to reject) traffic it has no
 * use for.
 */
const WEBHOOK_EVENTS = [
    'push',
    'create',
    'delete',
    'pull_request',
    'pull_request_sync',
    'pull_request_review_approved',
    'pull_request_review_rejected',
    'repository',
    // Forgejo Actions runs. There is no single "run finished" event: the outcome
    // is the event name, and all three carry the same body.
    'action_run_success',
    'action_run_failure',
    'action_run_recover'
];

/**
 * Build a client bound to one stored connection.
 *
 * Throws when the connection is not fully set up, because every caller either
 * needs a working client or needs to stop - there is no useful partial mode.
 */
export async function createClient(connectionId) {
    const connection = await getConnection(connectionId);
    if (!connection) throw new Error('That Forgejo connection no longer exists.');

    const secrets = await getConnectionSecrets(connectionId);
    if (!secrets?.clientSecret) throw new Error('This connection has no stored OAuth credentials.');

    let token = await getToken(connectionId);
    if (!token?.accessToken) {
        throw new Error('This connection is not authorized. Reconnect it from the Forgejo admin page.');
    }

    /**
     * Swap an expiring token for a fresh one and persist it, so sibling
     * invocations pick up the new token instead of each refreshing separately.
     */
    const refresh = async () => {
        const response = await refreshAccessToken({
            instanceUrl: connection.instanceUrl,
            clientId: connection.clientId,
            clientSecret: secrets.clientSecret,
            refreshToken: token.refreshToken
        });

        token = { ...toTokenRecord(response, token.username), connectedAt: token.connectedAt };
        await saveToken(connectionId, token);
        return token;
    };

    /**
     * Perform an authenticated request.
     *
     * Refreshing is attempted proactively when the stored expiry has passed, and
     * reactively on a 401 - a token can be revoked on the Forgejo side at any
     * moment, and the stored expiry says nothing about that.
     */
    const request = async (path, options = {}, { allowRetry = true } = {}) => {
        if (token.expiresAt && token.expiresAt <= Date.now() && token.refreshToken) {
            await refresh();
        }

        const response = await fetch(`${connection.instanceUrl}/api/v1${path}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${token.accessToken}`,
                Accept: 'application/json',
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...options.headers
            }
        });

        if (response.status === 401 && allowRetry && token.refreshToken) {
            await refresh();
            return request(path, options, { allowRetry: false });
        }

        return response;
    };

    /** Request and parse, turning a non-2xx into a thrown error with Forgejo's own message. */
    const requestJson = async (path, options) => {
        const response = await request(path, options);

        if (!response.ok) {
            throw new Error(`Forgejo ${path} failed (${response.status}): ${await response.text()}`);
        }

        // 204 No Content has no body to parse.
        if (response.status === 204) return undefined;

        return response.json();
    };

    /**
     * Read one page and report whether another exists.
     *
     * Forgejo sends the grand total in `X-Total-Count`, but not every endpoint and
     * not every version does, so a full page is also treated as "there may be
     * more". That can cost one extra empty request at the end, which is cheaper
     * than silently truncating a backfill.
     */
    const requestPage = async (path, page) => {
        const separator = path.includes('?') ? '&' : '?';
        const response = await request(`${path}${separator}page=${page}&limit=${PAGE_SIZE}`);

        if (!response.ok) {
            throw new Error(`Forgejo ${path} failed (${response.status}): ${await response.text()}`);
        }

        const items = await response.json();
        const list = Array.isArray(items) ? items : [];
        const total = Number(response.headers.get('x-total-count'));

        const hasMore = Number.isFinite(total) && total > 0
            ? page * PAGE_SIZE < total
            : list.length === PAGE_SIZE;

        return { items: list, hasMore, total: Number.isFinite(total) ? total : undefined };
    };

    return {
        connection,

        /** Repositories the authorizing user can see. Used to populate the picker. */
        listRepositories: (page = 1) => requestPage('/user/repos', page),

        getRepository: (owner, name) => requestJson(`/repos/${enc(owner)}/${enc(name)}`),

        /**
         * Commits on the default branch. `stat=false` and `files=false` keep the
         * response small - the app only needs a file *count*, and asking for the
         * full file list on every commit turns a backfill into a very slow one.
         */
        listCommits: (owner, name, page = 1) =>
            requestPage(`/repos/${enc(owner)}/${enc(name)}/commits?stat=false&files=false`, page),

        listBranches: (owner, name, page = 1) =>
            requestPage(`/repos/${enc(owner)}/${enc(name)}/branches`, page),

        /** `state=all` so closed and merged pull requests are backfilled too. */
        listPullRequests: (owner, name, page = 1) =>
            requestPage(`/repos/${enc(owner)}/${enc(name)}/pulls?state=all`, page),

        /**
         * Reviews left on one pull request.
         *
         * Whether a reviewer approved is not on the pull request object - Forgejo
         * even drops an approver from `requested_reviewers` once they have acted -
         * so the approval state in Jira can only come from here.
         */
        listPullRequestReviews: (owner, name, index) =>
            requestJson(`/repos/${enc(owner)}/${enc(name)}/pulls/${enc(index)}/reviews`),

        /**
         * Commits between two revisions, used when a push carries more commits than
         * Forgejo is willing to put in the webhook payload.
         */
        compareCommits: (owner, name, base, head) =>
            requestJson(`/repos/${enc(owner)}/${enc(name)}/compare/${enc(base)}...${enc(head)}`),

        listWebhooks: (owner, name) => requestJson(`/repos/${enc(owner)}/${enc(name)}/hooks`),

        /**
         * Create the repository webhook pointing back at this installation.
         *
         * Forgejo renamed the hook type from `gitea` to `forgejo`; older instances
         * only accept the former, so the newer name is tried first and the older one
         * is used as a fallback rather than failing the whole connect flow.
         */
        async createWebhook(owner, name, { url, secret }) {
            const payload = (type) => ({
                type,
                active: true,
                branch_filter: '*',
                events: WEBHOOK_EVENTS,
                config: { url, content_type: 'json', http_method: 'post', secret }
            });

            const response = await request(`/repos/${enc(owner)}/${enc(name)}/hooks`, {
                method: 'POST',
                body: JSON.stringify(payload('forgejo'))
            });

            if (response.ok) return response.json();

            const firstError = await response.text();

            const fallback = await request(`/repos/${enc(owner)}/${enc(name)}/hooks`, {
                method: 'POST',
                body: JSON.stringify(payload('gitea'))
            });

            if (fallback.ok) return fallback.json();

            throw new Error(
                `Could not create the webhook on ${owner}/${name} (${response.status}): ${firstError}`
            );
        },

        async deleteWebhook(owner, name, hookId) {
            const response = await request(`/repos/${enc(owner)}/${enc(name)}/hooks/${hookId}`, {
                method: 'DELETE'
            });

            // A hook the customer already removed by hand is not an error worth
            // blocking a disconnect on.
            if (!response.ok && response.status !== 404) {
                console.warn(
                    `Could not delete webhook ${hookId} on ${owner}/${name} (${response.status}).`
                );
            }
        }
    };
}

/** Owner and repository names can contain characters that need escaping in a path. */
function enc(segment) {
    return encodeURIComponent(String(segment));
}
