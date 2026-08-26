/**
 * Finds reactive expressions that Svelte 4 silently compiles to run once.
 *
 * Svelte 4 derives a reactive statement's dependency set from the identifiers
 * written in the statement itself. A `$:` or a template expression that calls a
 * *function declaration* whose body reads reactive state therefore has no
 * dependency on that state: the compiler emits the expression as one-time
 * initialisation, with no error and no warning. `{formatDate(game.releaseDate)}`
 * updates when `game` changes and never when `$language` does.
 *
 * The two cases are indistinguishable in the source, which is why this exists.
 * A function *expression* assigned in a `$:` is traced correctly and is not
 * reported.
 *
 * This is a lint, not a prover: it reports call sites whose dependencies are
 * narrower than what the callee reads, and names the reactive state that goes
 * untracked. Judgement still decides whether that state was meant to be tracked
 * - an imperative effect guarded on the right condition is reported and is fine.
 *
 * Usage: node scripts/svelte-frozen-props.mjs <component.svelte>...
 * Exits non-zero if any call site is reported, so it can gate a commit.
 */
import { parse, walk } from 'svelte/compiler';
import { transformSync } from 'esbuild';
import fs from 'node:fs';

function stripTypes(source) {
	return source.replace(
		/<script([^>]*\blang=["']ts["'][^>]*)>([\s\S]*?)<\/script>/g,
		(_m, attrs, body) =>
			`<script${attrs.replace(/\s*lang=["']ts["']/, '')}>` +
			transformSync(body, { loader: 'ts', target: 'esnext' }).code +
			'</script>'
	);
}

/** Identifiers a node reads, ignoring property names and declarations. */
function readsOf(node) {
	const found = new Set();
	walk(node, {
		enter(n, parent, key) {
			if (n.type !== 'Identifier') return;
			if (parent && parent.type === 'MemberExpression' && key === 'property') return;
			if (parent && parent.type === 'Property' && key === 'key') return;
			if (parent && /Function|VariableDeclarator|ClassDeclaration/.test(parent.type) && key === 'id') return;
			found.add(n.name);
		}
	});
	return found;
}

let reported = 0;

for (const file of process.argv.slice(2)) {
	const ast = parse(stripTypes(fs.readFileSync(file, 'utf8')));
	if (!ast.instance) continue;

	const callables = new Map();
	for (const node of ast.instance.content.body) {
		if (node.type === 'FunctionDeclaration' && node.id) {
			callables.set(node.id.name, node);
		} else if (node.type === 'VariableDeclaration') {
			for (const d of node.declarations) {
				if (d.id.type === 'Identifier' && d.init &&
					/ArrowFunctionExpression|FunctionExpression/.test(d.init.type)) {
					callables.set(d.id.name, d.init);
				}
			}
		}
	}

	/*
	 * Reactive state the component holds: store reads, props, and `let`
	 * bindings. `const` is excluded on purpose - it is never reassigned, so a
	 * callee reading one cannot go stale, and including them buried the real
	 * findings under every logger and every event dispatcher in the file.
	 */
	const reactive = new Set();
	for (const node of ast.instance.content.body) {
		if (node.type === 'VariableDeclaration') {
			if (node.kind === 'const') continue;
			for (const d of node.declarations) {
				if (d.id.type === 'Identifier') reactive.add(d.id.name);
			}
		} else if (node.type === 'LabeledStatement' && node.label.name === '$') {
			walk(node, {
				enter(n) {
					if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') {
						reactive.add(n.left.name);
					}
				}
			});
		}
	}
	walk(ast.instance, {
		enter(n) { if (n.type === 'Identifier' && n.name.startsWith('$')) reactive.add(n.name); }
	});

	function untracked(name, seen = new Set()) {
		if (seen.has(name)) return new Set();
		seen.add(name);
		const fn = callables.get(name);
		if (!fn) return new Set();
		const out = new Set();
		const bound = new Set((fn.params ?? []).flatMap((p) => [...readsOf(p)]));
		for (const id of readsOf(fn.body ?? fn)) {
			if (bound.has(id)) continue;
			if (reactive.has(id)) out.add(id);
			if (callables.has(id) && id !== name) for (const deep of untracked(id, seen)) out.add(deep);
		}
		return out;
	}

	function check(where, expr) {
		const written = readsOf(expr);
		for (const called of written) {
			if (!callables.has(called)) continue;
			const missing = [...untracked(called)].filter((id) => !written.has(id));
			if (missing.length === 0) continue;
			reported++;
			console.log(`${file}`);
			console.log(`  ${where}: ${called}() leaves ${missing.join(', ')} untracked`);
		}
	}

	if (ast.html) {
		walk(ast.html, {
			enter(n) {
				if (n.type === 'MustacheTag' || n.type === 'IfBlock' ||
					n.type === 'EachBlock' || n.type === 'AttributeShorthand') {
					if (n.expression) check('template', n.expression);
				}
			}
		});
	}
	for (const node of ast.instance.content.body) {
		if (node.type === 'LabeledStatement' && node.label.name === '$') {
			check('reactive statement', node.body);
		}
	}
}

if (reported > 0) {
	console.error(`\n${reported} reactive site(s) with untracked dependencies`);
	process.exit(1);
}
console.log('no frozen reactive sites found');
