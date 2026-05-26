import { Buffer } from "node:buffer";

const GPG_BIN = "gpg";

// Memoized across signArtifact() calls. A single release signs five
// artifacts; without memoization each call spawns a `gpg --version`
// subprocess just to re-confirm availability. The result is process-
// global rather than module-state because the gpg binary is global.
let gpgAvailabilityCheck: Promise<void> | undefined;

async function assertGpgAvailable(): Promise<void> {
  gpgAvailabilityCheck ??= (async () => {
    const proc = Bun.spawn([GPG_BIN, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `gpg is required to sign release artifacts but ` +
          `\`${GPG_BIN} --version\` exited with code ${String(code)}: ${stderr}`,
      );
    }
  })();
  return gpgAvailabilityCheck;
}

export async function signArtifact(
  bytes: Buffer,
  key?: string,
): Promise<Buffer> {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error("signArtifact: bytes must be a Buffer");
  }
  if (bytes.length === 0) {
    throw new Error("signArtifact: refusing to sign empty payload");
  }

  // Require an explicit signing key. Falling back to the operator's
  // default gpg identity means a release can be signed by a personal
  // key with no error surfaced — silent ambient authority that
  // downstream verifiers may not be willing to trust. The operator
  // must commit to a specific key via the argument or the env var.
  const resolvedKey = key ?? process.env.FLEX_RELEASE_GPG_KEY;
  if (resolvedKey === undefined || resolvedKey.trim().length === 0) {
    throw new Error(
      "signArtifact: a GPG signing key is required — pass `key` or set " +
        "FLEX_RELEASE_GPG_KEY. Falling back to gpg's default identity " +
        "would silently sign with whatever key is configured for the " +
        "operator, producing release artifacts whose signer is ambient " +
        "rather than committed.",
    );
  }

  await assertGpgAvailable();

  const args = [
    "--detach-sign",
    "--armor",
    "--batch",
    "--yes",
    "--local-user",
    resolvedKey,
  ];

  const proc = Bun.spawn([GPG_BIN, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.stdin.write(bytes);
  await proc.stdin.end();

  const [stdoutText, stderrText, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new Error(
      `gpg --detach-sign exited with code ${String(code)}: ${stderrText}`,
    );
  }

  const signature = Buffer.from(stdoutText);
  if (signature.length === 0) {
    throw new Error("gpg produced an empty signature");
  }
  return signature;
}
