import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commandExists,
  initStateFile,
  invocationName,
  parseCluster,
  requireEnv,
  sha256OfFile,
  stateSet,
} from "./cli-helpers";
import type { Logger } from "@faremeter/logs";

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warning: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
  } as unknown as Logger;
}

describe("invocationName", () => {
  const originalValue = process.env.FLEX_INVOCATION_NAME;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.FLEX_INVOCATION_NAME;
    } else {
      process.env.FLEX_INVOCATION_NAME = originalValue;
    }
  });

  test("returns the env value when FLEX_INVOCATION_NAME is set", () => {
    process.env.FLEX_INVOCATION_NAME = "program-rehearsal";
    expect(invocationName("scripts/src/foo.ts")).toBe("program-rehearsal");
  });

  test("returns the fallback when FLEX_INVOCATION_NAME is unset", () => {
    delete process.env.FLEX_INVOCATION_NAME;
    expect(invocationName("scripts/src/foo.ts")).toBe("scripts/src/foo.ts");
  });

  test("returns the fallback when FLEX_INVOCATION_NAME is the empty string", () => {
    process.env.FLEX_INVOCATION_NAME = "";
    expect(invocationName("scripts/src/foo.ts")).toBe("scripts/src/foo.ts");
  });
});

describe("parseCluster", () => {
  test("accepts devnet", () => {
    expect(parseCluster("devnet")).toBe("devnet");
  });

  test("accepts mainnet", () => {
    expect(parseCluster("mainnet")).toBe("mainnet");
  });

  test("throws on undefined", () => {
    expect(() => parseCluster(undefined)).toThrow(/devnet.*mainnet/);
  });

  test("throws on the empty string", () => {
    expect(() => parseCluster("")).toThrow(/devnet.*mainnet/);
  });

  test("throws on an unrecognized cluster", () => {
    expect(() => parseCluster("testnet")).toThrow(/devnet.*mainnet/);
  });
});

describe("requireEnv", () => {
  const VAR = "FLEX_CLI_HELPERS_TEST_VAR";
  const original = process.env[VAR];

  afterEach(() => {
    if (original === undefined) {
      Reflect.deleteProperty(process.env, VAR);
    } else {
      process.env[VAR] = original;
    }
  });

  test("returns the value when set", () => {
    process.env[VAR] = "hello";
    expect(requireEnv(VAR)).toBe("hello");
  });

  test("throws when the variable is unset", () => {
    Reflect.deleteProperty(process.env, VAR);
    expect(() => requireEnv(VAR)).toThrow(/required/);
  });

  test("throws when the variable is the empty string", () => {
    process.env[VAR] = "";
    expect(() => requireEnv(VAR)).toThrow(/required/);
  });
});

describe("sha256OfFile", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(
      os.tmpdir(),
      `cli-helpers-sha-${process.pid}-${String(Date.now())}`,
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  test("hashes empty file to the known sha256 of zero bytes", () => {
    fs.writeFileSync(tmpFile, "");
    expect(sha256OfFile(tmpFile)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("hashes 'abc' to its known sha256", () => {
    fs.writeFileSync(tmpFile, "abc");
    expect(sha256OfFile(tmpFile)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("commandExists", () => {
  test("returns true for a command that exists in PATH (sh)", () => {
    expect(commandExists("sh")).toBe(true);
  });

  test("returns false for a command that does not exist", () => {
    expect(commandExists("this-command-does-not-exist-flex-test")).toBe(false);
  });
});

describe("initStateFile", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = path.join(
      os.tmpdir(),
      `cli-helpers-state-${process.pid}-${String(Date.now())}`,
    );
  });

  afterEach(() => {
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("creates the state directory if it does not exist", () => {
    expect(fs.existsSync(stateDir)).toBe(false);
    initStateFile(silentLogger(), stateDir, "devnet");
    expect(fs.existsSync(stateDir)).toBe(true);
  });

  test("returns a path under the state directory", () => {
    const file = initStateFile(silentLogger(), stateDir, "devnet");
    expect(path.dirname(file)).toBe(stateDir);
    expect(path.basename(file)).toMatch(
      /^devnet-\d{8}T\d{9}Z-\d{4}\.state\.json$/,
    );
  });

  test("writes initial JSON with cluster and started fields", () => {
    const file = initStateFile(silentLogger(), stateDir, "mainnet");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      cluster: string;
      started: string;
    };
    expect(parsed.cluster).toBe("mainnet");
    expect(parsed.started).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("uses millisecond precision so back-to-back calls do not collide", () => {
    // Spec regression guard: a one-second-precision filename caused two
    // initStateFile calls in the same second to silently overwrite the
    // first state file, losing the audit trail.
    const a = initStateFile(silentLogger(), stateDir, "devnet");
    const b = initStateFile(silentLogger(), stateDir, "devnet");
    expect(a).not.toBe(b);
  });
});

describe("stateSet", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = path.join(
      os.tmpdir(),
      `cli-helpers-stateset-${process.pid}-${String(Date.now())}`,
    );
  });

  afterEach(() => {
    if (fs.existsSync(stateDir)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("writes a key into the state JSON without dropping existing fields", () => {
    const file = initStateFile(silentLogger(), stateDir, "devnet");
    stateSet(file, "step", "compose");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.cluster).toBe("devnet");
    expect(parsed.step).toBe("compose");
  });

  test("overwrites an existing key", () => {
    const file = initStateFile(silentLogger(), stateDir, "devnet");
    stateSet(file, "step", "compose");
    stateSet(file, "step", "execute");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.step).toBe("execute");
  });
});

// prompt() and closePromptReadline() touch process.stdin, which means
// they cannot be exercised meaningfully inside the bun test runner's
// own process (stdin is the test runner's, not a clean slate). The
// tests below run a small fixture script as a child process and assert
// on its stdout/stderr, the same approach the squads-cli and close
// subcommand tests use.

const PROMPT_FIXTURE_SCRIPT = path.join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "src",
  "cli-helpers-prompt-fixture.ts",
);

describe("prompt", () => {
  beforeEach(() => {
    // Write the fixture script as a tracked, ephemeral helper. It
    // lives next to the source under test so its imports are stable.
    const src = `
import { closePromptReadline, prompt } from "./cli-helpers";

const mode = process.argv[2] ?? "two-prompts";
try {
  if (mode === "two-prompts") {
    const a = await prompt("first: ");
    const b = await prompt("second: ");
    process.stdout.write(JSON.stringify({ a, b }) + "\\n");
  } else if (mode === "concurrent") {
    const p1 = prompt("first: ");
    try {
      await prompt("second: ");
      process.stdout.write("concurrent: no throw\\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(JSON.stringify({ concurrentError: msg }) + "\\n");
    }
    await p1;
  }
} finally {
  closePromptReadline();
}
`;
    fs.writeFileSync(PROMPT_FIXTURE_SCRIPT, src);
  });

  afterEach(() => {
    if (fs.existsSync(PROMPT_FIXTURE_SCRIPT)) {
      fs.unlinkSync(PROMPT_FIXTURE_SCRIPT);
    }
  });

  test("reads two back-to-back piped lines in order", () => {
    const result = spawnSync("bun", [PROMPT_FIXTURE_SCRIPT, "two-prompts"], {
      input: "alpha\nbravo\n",
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('{"a":"alpha","b":"bravo"}');
  });

  test("a second concurrent prompt() throws while the first is pending", () => {
    const result = spawnSync("bun", [PROMPT_FIXTURE_SCRIPT, "concurrent"], {
      input: "alpha\n",
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sequential-only");
  });
});

describe("closePromptReadline", () => {
  beforeEach(() => {
    fs.writeFileSync(
      PROMPT_FIXTURE_SCRIPT,
      `
import { closePromptReadline, prompt } from "./cli-helpers";
const a = await prompt("first: ");
process.stdout.write(JSON.stringify({ a }) + "\\n");
closePromptReadline();
process.stdout.write("after-close\\n");
`,
    );
  });

  afterEach(() => {
    if (fs.existsSync(PROMPT_FIXTURE_SCRIPT)) {
      fs.unlinkSync(PROMPT_FIXTURE_SCRIPT);
    }
  });

  test("releases stdin so the event loop drains and the process exits", () => {
    // If closePromptReadline failed to release stdin, the script would
    // hang indefinitely waiting for more input. spawnSync's default
    // timeout is infinite; use a deadline to fail the test deterministically
    // rather than block.
    const start = Date.now();
    const result = spawnSync("bun", [PROMPT_FIXTURE_SCRIPT], {
      input: "alpha\n",
      encoding: "utf-8",
      timeout: 5000,
    });
    const elapsed = Date.now() - start;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('{"a":"alpha"}');
    expect(result.stdout).toContain("after-close");
    // A clean exit takes well under a second on bun; if it took the
    // full 5s the closePromptReadline call did not release stdin.
    expect(elapsed).toBeLessThan(2000);
  });
});
