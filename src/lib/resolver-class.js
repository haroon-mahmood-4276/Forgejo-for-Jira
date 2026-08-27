/**
 * Recover the `Resolver` constructor from `@forge/resolver`.
 *
 * The package ships as CommonJS with `exports.default = Resolver`, and how many
 * layers of `default` an ESM importer sees depends on who did the transpiling:
 *
 * - Under Forge's webpack build, `import * as m` gives `m.default === Resolver`.
 * - Under plain Node's CommonJS interop (which is what the test suite runs on),
 *   `m.default` is the whole `module.exports` object, so the constructor is one
 *   level further down at `m.default.default`.
 *
 * A plain `import Resolver from '@forge/resolver'` therefore yields a namespace
 * object under one of them and throws "Resolver is not a constructor". Unwrapping
 * until a function appears works under both, and fails loudly if a future
 * version changes shape again.
 */
export function resolverClass(module) {
    let candidate = module;

    for (let depth = 0; depth < 5 && candidate && typeof candidate !== 'function'; depth += 1) {
        candidate = candidate.default;
    }

    if (typeof candidate !== 'function') {
        throw new Error('Could not find the Resolver constructor in @forge/resolver.');
    }

    return candidate;
}
