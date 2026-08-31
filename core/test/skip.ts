/**
 * Conditional skipping, ported from `node:test` to `bun:test`.
 *
 * `node:test` took an options object as a second argument, so a test that
 * needs the built core or a real ROM could say `test(name, { skip: reason },
 * fn)` and the reason showed up in the TAP output. `bun:test` has no options
 * argument at all -- only `test.skip` / `test.skipIf`, neither of which
 * carries a reason. Dropping the reason would turn "core not built - run
 * ./core/build.sh" into a bare `(skip)`, which is exactly the kind of silent
 * nothing that #8 was about: a suite that looks like it ran and did not.
 *
 * So the reason is folded into the test name instead, which is the one field
 * that survives everywhere a skipped test is listed at all -- bun's default
 * reporter prints only a count, but `--reporter=junit` carries the name, and so
 * does the source anyone reads next.
 *
 * Usage mirrors the old shape:
 *
 *   const needsRom = optional(rom ? false : 'no test ROM found');
 *   needsRom('a real session stays bit-identical', async () => { ... });
 */
import { test } from 'bun:test';

type TestFn = Parameters<typeof test>[1];

export function optional(reason: string | false): (name: string, fn: TestFn) => void {
	if (reason === false) return test;
	return (name, fn) => test.skip(`${name} [skipped: ${reason}]`, fn);
}
