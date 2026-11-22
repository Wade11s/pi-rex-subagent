import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const HOST_PROVIDED_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
] as const;

test("host-provided extension packages are only wildcard peer dependencies", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
		dependencies?: Record<string, string>;
		peerDependencies?: Record<string, string>;
	};
	for (const name of HOST_PROVIDED_PACKAGES) {
		assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be installed as a duplicate runtime package`);
		if (manifest.peerDependencies?.[name] !== undefined) {
			assert.equal(manifest.peerDependencies[name], "*", `${name} must use the host-provided wildcard range`);
		}
	}
	assert.equal(manifest.peerDependencies?.typebox, "*", "typebox is supplied by Pi and must be declared explicitly");
});
