import { getConnectionSecrets } from './storage.js';
import { getRawBody, readSignature, verifySignature } from './verify-signature.js';

/**
 * Authentication of inbound web trigger deliveries.
 *
 * Two public URLs accept traffic from outside Atlassian: the repository webhook
 * receiver and the Forgejo Actions reporter. Both are reached the same way and
 * both are verified the same way, so the steps live here once rather than as two
 * copies that could drift apart - a check missing from one receiver would be a
 * hole in the app, however careful the other one was.
 *
 * Every delivery must:
 *
 *  1. name a connection with the `c` query parameter - a selector only, which
 *     chooses the signing secret and grants nothing on its own;
 *  2. name a connection that exists in this installation;
 *  3. carry an HMAC-SHA256 signature over the body made with that secret;
 *  4. be valid JSON.
 *
 * Each failure is rejected with a distinct status so the sender can tell what
 * went wrong, and rejected *before* the body is interpreted in any way.
 */

/**
 * What a connection identifier may look like. Generated ids are 24 hex
 * characters (see `storage.newConnectionId`); the pattern is a little wider than
 * that so the format can change without every stored URL becoming invalid, but
 * it never admits a path separator, whitespace or a storage-key delimiter.
 */
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether a value is shaped like a connection identifier. */
export function isConnectionId(value) {
    return typeof value === 'string' && CONNECTION_ID_PATTERN.test(value);
}

/**
 * Forge supplies query parameters as arrays, because a parameter can legally
 * repeat. Only the first value is meaningful anywhere in this app.
 */
export function firstQueryValue(queryParameters = {}, name) {
    const value = queryParameters?.[name];
    return Array.isArray(value) ? value[0] : value;
}

/** Flatten every query parameter to its first value. */
export function flattenQuery(queryParameters = {}) {
    const result = {};
    for (const [key, value] of Object.entries(queryParameters ?? {})) {
        result[key] = Array.isArray(value) ? value[0] : value;
    }
    return result;
}

/**
 * Verify a delivery and parse its body.
 *
 * Returns `{ ok: true, connectionId, payload }` on success, or
 * `{ ok: false, response }` carrying the web trigger response to return.
 *
 * `label` names the receiver in log lines, so a rejected webhook and a rejected
 * CI report can be told apart when reading logs.
 */
export async function authenticateDelivery(request, label) {
    const connectionId = firstQueryValue(request?.queryParameters, 'c');

    // Fail closed. Without a connection there is no secret to verify against,
    // so there is no safe way to fall through to processing the payload.
    if (!connectionId) {
        console.warn(`Rejected ${label} delivery with no connection identifier.`);
        return reject(400, 'Missing connection identifier');
    }

    // A value that cannot be a connection id is refused before storage is asked
    // about it. The store would say "not found" anyway; this keeps arbitrary
    // strings out of storage keys and out of the logs.
    if (!isConnectionId(connectionId)) {
        console.warn(`Rejected ${label} delivery with a malformed connection identifier.`);
        return reject(400, 'Malformed connection identifier');
    }

    const secrets = await getConnectionSecrets(connectionId);
    if (!secrets?.webhookSecret) {
        console.warn(`Rejected ${label} delivery for unknown connection ${connectionId}.`);
        return reject(404, 'Unknown connection');
    }

    const rawBody = getRawBody(request);

    if (!verifySignature(rawBody, readSignature(request?.headers), secrets.webhookSecret)) {
        console.warn(`Rejected ${label} delivery for ${connectionId} with an invalid signature.`);
        return reject(401, 'Invalid signature');
    }

    let payload;
    try {
        payload = JSON.parse(rawBody);
    } catch (error) {
        console.error(`${label} body was not valid JSON: ${error.message}`);
        return reject(400, 'Malformed JSON body');
    }

    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return reject(400, 'Body must be a JSON object');
    }

    return { ok: true, connectionId, payload };
}

function reject(statusCode, body) {
    return { ok: false, response: { statusCode, body } };
}
