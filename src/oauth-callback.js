import { exchangeCodeForToken, fetchAuthenticatedUser, toTokenRecord } from './lib/forgejo-oauth.js';
import { consumePendingState, getConnection, saveConnection, saveToken } from './lib/storage.js';

/**
 * Web trigger that Forgejo redirects the browser back to after the admin
 * approves (or denies) the authorization request.
 *
 * This runs in a real browser tab rather than as an API call, so it answers with
 * HTML: the person who clicked Connect needs to see whether it worked.
 */
export async function handleOAuthCallback(request) {
    const query = normaliseQuery(request.queryParameters);

    // Forgejo reports a denied or failed authorization via `error`.
    if (query.error) {
        console.warn('Forgejo authorization was denied or failed:', query.error);
        return page(400, 'Authorization failed', [
            `Forgejo reported: ${escapeHtml(query.error_description || query.error)}`
        ]);
    }

    // The `state` value proves this callback belongs to an authorization request
    // this app started. Consuming it also recovers which connection is being
    // authorized and the matching PKCE verifier - neither is read from the URL.
    const pending = await consumePendingState(query.state);
    if (!pending) {
        console.warn('Rejected OAuth callback with an unknown or expired state value.');
        return page(400, 'Authorization failed', [
            'This authorization link is invalid or has already been used.',
            'Start again from <strong>Settings &rsaquo; Apps &rsaquo; Forgejo for Jira</strong>.'
        ]);
    }

    if (!query.code) {
        return page(400, 'Authorization failed', ['Forgejo did not return an authorization code.']);
    }

    try {
        const connection = await getConnection(pending.connectionId);
        if (!connection) throw new Error('That connection was removed while you were authorizing.');

        const token = await exchangeCodeForToken({
            instanceUrl: pending.instanceUrl,
            clientId: pending.clientId,
            clientSecret: pending.clientSecret,
            code: query.code,
            redirectUri: pending.redirectUri,
            codeVerifier: pending.codeVerifier
        });

        // Prove the token actually works before calling the connection successful.
        // A stored token that turns out to be unusable is worse than no token: the
        // admin walks away believing setup is finished.
        const user = await fetchAuthenticatedUser({
            instanceUrl: pending.instanceUrl,
            accessToken: token.access_token
        });

        const username = user.preferred_username || user.name || user.login || 'unknown user';

        // Tokens are secrets: stored encrypted, never returned to any frontend.
        await saveToken(pending.connectionId, toTokenRecord(token, username));

        await saveConnection({ ...connection, connectedAt: Date.now(), username });

        console.log(`Connection ${pending.connectionId} authorized as ${username}.`);

        return page(200, 'Connected to Forgejo', [
            `Signed in as <strong>${escapeHtml(username)}</strong>.`,
            'You can close this tab and return to Jira, then choose which repositories to connect.'
        ]);
    } catch (error) {
        console.error('OAuth token exchange failed:', error.message);
        return page(500, 'Authorization failed', [escapeHtml(error.message)]);
    }
}

/**
 * Forge supplies query parameters as arrays, because a parameter can legally
 * repeat. Flatten to the first value of each, which is what OAuth expects.
 */
function normaliseQuery(queryParameters = {}) {
    const result = {};
    for (const [key, value] of Object.entries(queryParameters)) {
        result[key] = Array.isArray(value) ? value[0] : value;
    }
    return result;
}

/**
 * Escape anything echoed back into the page.
 *
 * Error strings in the callback URL are attacker-controlled - the URL is a
 * public endpoint that anyone can request with any query string - so without
 * escaping this handler would be a reflected XSS.
 */
function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * A minimal self-contained result page. No external stylesheet or script is
 * referenced, so nothing here can be blocked or tampered with in transit.
 */
function page(statusCode, heading, paragraphs) {
    const body = paragraphs.map((text) => `<p>${text}</p>`).join('\n    ');

    return {
        statusCode,
        headers: {
            'Content-Type': ['text/html; charset=utf-8'],
            // This page never needs to be framed, and framing it would only serve a
            // clickjacking attempt.
            'X-Frame-Options': ['DENY'],
            'Content-Security-Policy': ["default-src 'none'; style-src 'unsafe-inline'"]
        },
        body: `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title></head>
  <body style="font-family: -apple-system, system-ui, sans-serif; padding: 2rem; max-width: 40rem; line-height: 1.5;">
    <h1 style="font-size: 1.25rem;">${heading}</h1>
    ${body}
  </body>
</html>`
    };
}
