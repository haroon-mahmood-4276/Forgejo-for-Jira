import crypto from 'crypto';

/**
 * The Forgejo OAuth 2.0 authorization code flow.
 *
 * Forgejo is self-hosted, so there is no single well-known provider to register
 * with. Each customer registers an OAuth application on their own instance
 * (Settings -> Applications) and pastes the resulting client ID and secret into
 * this app's admin page.
 *
 * Storage of the resulting tokens is deliberately not this module's job - see
 * `storage.js`. This file only speaks the protocol.
 */

// Forgejo's OAuth endpoints, relative to the instance base URL.
const AUTHORIZE_PATH = '/login/oauth/authorize';
const TOKEN_PATH = '/login/oauth/access_token';
const USERINFO_PATH = '/login/oauth/userinfo';

/**
 * Normalise a user-entered instance URL.
 *
 * Trailing slashes are stripped so no built URL ever contains a double slash,
 * and anything that is not HTTPS is rejected - the OAuth client secret and
 * access token travel over this connection. Plain HTTP is allowed only for
 * localhost, which exists purely so the app can be exercised against a local
 * Forgejo during development.
 */
export function normaliseInstanceUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        throw new Error('Forgejo instance URL is required.');
    }

    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        throw new Error('Forgejo instance URL is not a valid URL.');
    }

    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
        throw new Error('Forgejo instance URL must use HTTPS.');
    }

    // Credentials in the URL would be sent on every request and stored in plain
    // storage alongside the URL; the OAuth application is the credential here.
    if (parsed.username || parsed.password) {
        throw new Error('Forgejo instance URL must not contain a username or password.');
    }

    if (parsed.search || parsed.hash) {
        throw new Error('Forgejo instance URL must be a base URL with no query string or fragment.');
    }

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * PKCE (Proof Key for Code Exchange) protects the authorization code against
 * interception. A random `code_verifier` is generated, only its SHA-256 hash
 * (`code_challenge`) is sent on the authorize request, and the verifier is
 * revealed when exchanging the code. Forgejo supports the S256 method.
 */
export function createPkcePair() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/**
 * The `state` parameter defends against CSRF: it is stored before redirecting
 * and the callback must present the same value back.
 */
export function createState() {
    return crypto.randomBytes(24).toString('base64url');
}

/**
 * Build the URL the admin's browser is sent to in order to approve access.
 */
export function buildAuthorizeUrl({ instanceUrl, clientId, redirectUri, state, codeChallenge }) {
    const url = new URL(`${instanceUrl}${AUTHORIZE_PATH}`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
}

/**
 * Exchange an authorization code for an access token.
 *
 * Note: Forgejo has not implemented OAuth scopes, so the token returned here
 * carries the full permissions of the approving user. It is stored encrypted and
 * never returned to the browser.
 */
export async function exchangeCodeForToken({
    instanceUrl,
    clientId,
    clientSecret,
    code,
    redirectUri,
    codeVerifier
}) {
    return postToken(instanceUrl, {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
    });
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * Forgejo access tokens are short lived (one hour by default). Without this the
 * app would stop being able to reach Forgejo an hour after connecting, and an
 * admin would have to reconnect by hand - which for a backfill running in the
 * background means it simply dies part way through.
 */
export async function refreshAccessToken({ instanceUrl, clientId, clientSecret, refreshToken }) {
    if (!refreshToken) {
        throw new Error('No refresh token is stored for this connection.');
    }

    return postToken(instanceUrl, {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });
}

/**
 * Shared POST to the token endpoint. Both grants use the same request and
 * response handling, and both fail in the same ways.
 */
async function postToken(instanceUrl, body) {
    const response = await fetch(`${instanceUrl}${TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(`Forgejo token request failed (${response.status}): ${text}`);
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Forgejo token endpoint returned a non-JSON response.');
    }

    if (!parsed.access_token) {
        throw new Error('Forgejo token response did not contain an access_token.');
    }

    return parsed;
}

/**
 * Confirm the token works and find out who it belongs to.
 *
 * This is what turns "a token was stored" into "we are actually authenticated",
 * and gives the admin page a username to display as proof of a live connection.
 */
export async function fetchAuthenticatedUser({ instanceUrl, accessToken }) {
    const response = await fetch(`${instanceUrl}${USERINFO_PATH}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });

    if (!response.ok) {
        throw new Error(
            `Could not read Forgejo user info (${response.status}): ${await response.text()}`
        );
    }

    return response.json();
}

/**
 * Convert a token response into the record shape `storage.js` persists.
 *
 * `expires_in` is a duration in seconds; it is converted to an absolute
 * timestamp so expiry can be checked later without tracking elapsed time.
 * A 60-second safety margin is subtracted so a token is never used in the
 * moment it expires mid-request.
 */
export function toTokenRecord(tokenResponse, username) {
    return {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: tokenResponse.expires_in
            ? Date.now() + (tokenResponse.expires_in - 60) * 1000
            : undefined,
        username,
        connectedAt: Date.now()
    };
}
