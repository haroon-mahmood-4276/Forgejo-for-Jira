/**
 * In-memory stand-ins for the Forge platform packages.
 *
 * These exist so the whole app can be exercised under plain Node, with no Forge
 * installation, no Jira site and no Forgejo instance. They are installed with a
 * module loader hook (see `local-test.mjs`), which is what lets the real source
 * files be imported unmodified - the alternative, dependency-injecting every
 * platform call, would change the production code to suit its tests.
 *
 * Each stub is deliberately shallow: it reproduces the shapes the app actually
 * depends on, and nothing else.
 */

import { register } from 'node:module';

/**
 * Everything the tests need to observe or control, hung off `globalThis` so the
 * data-URI stub modules can reach it. They are separate module instances with no
 * other way to share state.
 */
export const harness = {
    /** Jira REST calls the app made, newest last. */
    jiraRequests: [],
    /** Async events pushed onto the backfill queue. */
    queued: [],
    /** Outbound fetches to Forgejo. */
    fetches: [],
    /** The key-value store. */
    store: new Map(),
    /** Queued responses for `fetch`, consumed in order. */
    fetchResponses: [],
    /** Next response for a Jira call; reset to 202 after each use. */
    jiraResponse: undefined,
    /** Set to a message to make every queue push reject. */
    queuePushError: undefined,

    reset() {
        this.queuePushError = undefined;
        this.jiraRequests.length = 0;
        this.queued.length = 0;
        this.fetches.length = 0;
        this.fetchResponses.length = 0;
        this.store.clear();
        this.jiraResponse = undefined;
    },

    /** Queue a Forgejo API response for the next `fetch`. */
    respondWith(body, { status = 200, headers = {} } = {}) {
        this.fetchResponses.push({ body, status, headers });
    }
};

globalThis.__harness = harness;

// ---------------------------------------------------------------------------
// @forge/api
// ---------------------------------------------------------------------------

const forgeApi = `
  const h = globalThis.__harness;

  // The real tag escapes interpolated values; reproducing that matters, because
  // forgetting it is exactly the bug this shape is meant to catch.
  export const route = (strings, ...values) =>
    strings.reduce((acc, s, i) => acc + s + (i < values.length ? encodeURIComponent(values[i]) : ''), '');

  const requestJira = async (path, options = {}) => {
    h.jiraRequests.push({ path, method: options.method ?? 'GET', options });

    const canned = h.jiraResponse;
    h.jiraResponse = undefined;

    const status = canned?.status ?? 202;
    const body = canned?.body ?? JSON.stringify({ acceptedDevinfoEntities: {} });

    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body)
    };
  };

  export const webTrigger = {
    getUrl: async (key) => 'https://trigger.example/x1/' + key
  };

  const api = {
    asApp: () => ({ requestJira }),
    asUser: () => ({ requestJira })
  };

  export default api;
`;

// ---------------------------------------------------------------------------
// @forge/kvs
// ---------------------------------------------------------------------------

const forgeKvs = `
  const h = globalThis.__harness;

  // Values are round-tripped through JSON so a test cannot accidentally pass by
  // mutating an object the store still holds a reference to.
  const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  export const WhereConditions = {
    beginsWith: (value) => ({ condition: 'BEGINS_WITH', value })
  };

  export const FilterConditions = {};

  const queryBuilder = () => {
    const state = { prefix: '', limit: 100 };
    const builder = {
      where(_property, condition) {
        state.prefix = condition.value;
        return builder;
      },
      limit(value) {
        state.limit = value;
        return builder;
      },
      cursor(value) {
        state.cursor = value;
        return builder;
      },
      async getMany() {
        const results = [...h.store.entries()]
          .filter(([key]) => key.startsWith(state.prefix))
          .map(([key, value]) => ({ key, value: clone(value) }));
        // The real API pages; the stub returns everything at once, which is the
        // same contract with nextCursor always absent.
        return { results, nextCursor: undefined };
      },
      async getOne() {
        const page = await builder.getMany();
        return page.results[0];
      }
    };
    return builder;
  };

  export const kvs = {
    async get(key) { return clone(h.store.get(key)); },
    async set(key, value) { h.store.set(key, clone(value)); },
    async delete(key) { h.store.delete(key); },
    // The stub does not encrypt; what matters for the tests is that secret and
    // non-secret keys share a namespace and that secrets are never queryable.
    async getSecret(key) { return clone(h.store.get('secret::' + key)); },
    async setSecret(key, value) { h.store.set('secret::' + key, clone(value)); },
    async deleteSecret(key) { h.store.delete('secret::' + key); },
    query: queryBuilder
  };

  export default kvs;
`;

// ---------------------------------------------------------------------------
// @forge/events
// ---------------------------------------------------------------------------

const forgeEvents = `
  const h = globalThis.__harness;

  export class Queue {
    constructor(params) { this.key = params.key; }
    async push(event) {
      // Lets a test drive the "the platform rejected the push" path, which is
      // how a repository once ended up permanently stuck reading "queued".
      if (h.queuePushError) throw new Error(h.queuePushError);
      h.queued.push(event);
      return { jobId: 'job-' + h.queued.length };
    }
    async cancel() {}
    async getStats() { return {}; }
    getJob() { return {}; }
  }

  export const InvocationErrorCode = {
    FUNCTION_RETRY_REQUEST: 'FUNCTION_RETRY_REQUEST',
    FUNCTION_TIME_OUT: 'FUNCTION_TIME_OUT'
  };

  // The real InvocationError returns a plain object from its constructor, so
  // what a consumer hands back to Forge is \`{_retry, retryOptions}\` and not an
  // instance. Reproducing that exactly is the point - a stub that returned an
  // instance would let a test pass on a shape Forge never sees.
  export class InvocationError {
    constructor(retryOptions = {}) {
      return { _retry: true, retryOptions };
    }
  }
`;

// ---------------------------------------------------------------------------
// Loader hook
// ---------------------------------------------------------------------------

const stubs = {
    '@forge/api': forgeApi,
    '@forge/kvs': forgeKvs,
    '@forge/events': forgeEvents
};

const stubUrls = Object.fromEntries(
    Object.entries(stubs).map(([specifier, source]) => [
        specifier,
        'data:text/javascript,' + encodeURIComponent(source)
    ])
);

register(
    'data:text/javascript,' +
    encodeURIComponent(`
      const urls = ${JSON.stringify(stubUrls)};
      export async function resolve(specifier, context, next) {
        if (urls[specifier]) return { url: urls[specifier], shortCircuit: true };
        return next(specifier, context);
      }
    `),
    import.meta.url
);

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

/**
 * Replace global fetch so Forgejo API calls are observable and scriptable.
 * Unqueued calls answer with an empty array, which is what an exhausted page
 * looks like - the safe default for a paging loop.
 */
globalThis.fetch = async (url, options = {}) => {
    harness.fetches.push({ url: String(url), method: options.method ?? 'GET', options });

    const canned = harness.fetchResponses.shift() ?? { body: [], status: 200, headers: {} };
    const text = typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body);
    const headers = new Map(
        Object.entries(canned.headers).map(([key, value]) => [key.toLowerCase(), String(value)])
    );

    return {
        ok: canned.status >= 200 && canned.status < 300,
        status: canned.status,
        headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
        text: async () => text,
        json: async () => JSON.parse(text)
    };
};
