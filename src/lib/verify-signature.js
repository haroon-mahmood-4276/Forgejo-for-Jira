import crypto from 'crypto';

/**
 * Shared HMAC verification for every inbound web trigger.
 *
 * Both the repository webhook and the Forgejo Actions CI reporter sign their
 * payloads the same way, so they share this implementation rather than each
 * growing its own subtly different copy.
 */

/**
 * Return the request body as the exact string that was signed.
 *
 * Forge may hand the body over base64-encoded (for example when the content
 * type is not recognised as text). Hashing the encoded form would produce a
 * digest that never matches, silently rejecting every valid delivery, so decode
 * back to the original bytes first.
 */
export function getRawBody(request) {
    if (request?.body == null) return '';
    return request.isBase64Encoded
        ? Buffer.from(request.body, 'base64').toString('utf8')
        : request.body;
}

/**
 * Forge exposes headers as arrays because HTTP allows repeated header names.
 * Header lookup is case-insensitive per the HTTP spec, so normalise the keys.
 */
export function firstHeader(headers = {}, name) {
    const match = Object.keys(headers).find((key) => key.toLowerCase() === name);
    if (!match) return undefined;

    const value = headers[match];
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Go's `encoding/json` escapes these three characters by default, so that a JSON
 * document is safe to embed directly in HTML. `JSON.stringify` does not.
 * They only ever occur inside string values, so replacing them globally cannot
 * disturb the document's structure.
 */
const GO_HTML_ESCAPES = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' };

/**
 * Re-render a parsed payload the way Forgejo serialised it.
 *
 * Forgejo is Go, and writes its webhook bodies with `json.MarshalIndent` at two
 * spaces, so this reproduces the exact bytes it hashed.
 */
function forgejoRendering(rawBody) {
    try {
        const pretty = JSON.stringify(JSON.parse(rawBody), null, 2);
        return pretty.replace(/[<>&]/g, (character) => GO_HTML_ESCAPES[character]);
    } catch {
        // Not JSON, or not parseable - there is nothing to reconstruct from.
        return undefined;
    }
}

/**
 * The renderings of this body that the sender might have signed.
 *
 * Forge's web trigger strips line feeds out of the request body before handing
 * it to the function: a 149-byte pretty-printed body carrying 11 newlines
 * arrives as 138 bytes with none. Forgejo signs the bytes it actually put on the
 * wire, so hashing what we receive produces a digest that can never match, and
 * every signed delivery would be rejected as a forgery.
 *
 * Reconstructing the original from the parsed payload is what makes verification
 * possible at all. The body as delivered is still tried first, so a sender that
 * does not pretty-print - and any future platform fix - keeps working untouched.
 *
 * The reconstruction relies on key order surviving `JSON.parse`, which it does
 * except for integer-like keys; Forgejo's payloads have none.
 */
export function signedBodyCandidates(rawBody) {
    const candidates = [rawBody];

    const rendered = forgejoRendering(rawBody);
    if (rendered !== undefined && rendered !== rawBody) candidates.push(rendered);

    return candidates;
}

/**
 * Constant-time HMAC-SHA256 comparison.
 *
 * A plain `===` on digests leaks timing information: it returns as soon as it
 * finds a differing byte, which lets an attacker discover the correct signature
 * one byte at a time. `crypto.timingSafeEqual` always compares the full buffer.
 * It throws when the two buffers differ in length, so check that first.
 *
 * Each candidate rendering gets its own full-strength check. Trying more than
 * one weakens nothing: a forger still has to produce a digest that matches the
 * secret for one of them, which is the same problem as matching a single one.
 */
export function verifySignature(rawBody, signature, secret) {
    if (!secret || !signature) return false;

    let received;
    try {
        received = Buffer.from(signature, 'hex');
    } catch {
        return false;
    }

    // SHA-256 digests are 32 bytes. A shorter buffer means the header was
    // truncated or not hex, and timingSafeEqual would throw on the mismatch.
    if (received.length !== 32) return false;

    return signedBodyCandidates(rawBody).some((candidate) => {
        const expected = crypto.createHmac('sha256', secret).update(candidate, 'utf8').digest();
        return crypto.timingSafeEqual(expected, received);
    });
}

/**
 * Read the signature header, accepting Forgejo's name and Gitea's older one.
 */
export function readSignature(headers) {
    return (
        firstHeader(headers, 'x-forgejo-signature') ?? firstHeader(headers, 'x-gitea-signature')
    );
}

/**
 * Read the event-type header, accepting Forgejo's name and Gitea's older one.
 */
export function readEventType(headers) {
    return firstHeader(headers, 'x-forgejo-event') ?? firstHeader(headers, 'x-gitea-event');
}
