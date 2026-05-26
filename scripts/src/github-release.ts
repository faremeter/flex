import { Buffer } from "node:buffer";
import { detectRepoURL } from "./solana";

const GH_BIN = "gh";
const GITHUB_API = "https://api.github.com";

export type ReleaseArtifact = {
  name: string;
  bytes: Buffer;
  gpgSig: Buffer;
};

function assertNonBlank(name: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-blank string`);
  }
}

async function hasGhCli(): Promise<boolean> {
  try {
    const proc = Bun.spawn([GH_BIN, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

type Repo = { owner: string; repo: string };

function detectRepoFromGitRemote(): Repo {
  // detectRepoURL handles the spawn + ssh/https normalisation; we just
  // parse owner/repo out of the canonical https form it returns.
  const url = detectRepoURL();
  const match = /^https:\/\/github\.com\/([^/]+)\/(.+?)$/.exec(url);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(
      `unexpected detectRepoURL output (expected https://github.com/owner/repo): ${url}`,
    );
  }
  return { owner: match[1], repo: match[2] };
}

function requireGithubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error(
      "neither `gh` CLI nor GITHUB_TOKEN are available; one is required " +
        "to talk to GitHub Releases",
    );
  }
  return token;
}

async function fetchArtifactViaGh(
  tag: string,
  filename: string,
): Promise<Buffer> {
  const proc = Bun.spawn(
    [GH_BIN, "release", "download", tag, "-p", filename, "-O", "-"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdoutBuf, stderrText, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `gh release download ${tag} -p ${filename} failed with code ${String(code)}: ${stderrText}`,
    );
  }
  const out = Buffer.from(stdoutBuf);
  if (out.length === 0) {
    throw new Error(
      `gh release download ${tag} -p ${filename} returned empty payload`,
    );
  }
  return out;
}

type GithubAsset = {
  name: string;
  url: string;
};

type GithubReleaseResponse = {
  id: number;
  html_url: string;
  upload_url: string;
  assets: GithubAsset[];
};

function isGithubReleaseResponse(
  value: unknown,
): value is GithubReleaseResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "number" &&
    typeof v.html_url === "string" &&
    typeof v.upload_url === "string" &&
    Array.isArray(v.assets)
  );
}

type GithubRequestInit = {
  body?: string | Uint8Array;
  headers?: Record<string, string>;
};

async function githubRequest(
  token: string,
  method: string,
  url: string,
  init?: GithubRequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "flex-release-pipeline",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
    ...init?.headers,
  };
  const response = await fetch(url, {
    method,
    headers,
    ...(init?.body !== undefined ? { body: init.body } : {}),
  });
  return response;
}

async function fetchArtifactViaRest(
  tag: string,
  filename: string,
): Promise<Buffer> {
  const token = requireGithubToken();
  const { owner, repo } = detectRepoFromGitRemote();
  const releaseUrl = `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const releaseRes = await githubRequest(token, "GET", releaseUrl);
  if (!releaseRes.ok) {
    const errText = await releaseRes.text();
    throw new Error(
      `GitHub GET ${releaseUrl} failed: ${String(releaseRes.status)} ${releaseRes.statusText}: ${errText}`,
    );
  }
  const releaseJson: unknown = await releaseRes.json();
  if (!isGithubReleaseResponse(releaseJson)) {
    throw new Error(
      `GitHub release payload missing expected fields: ${JSON.stringify(releaseJson)}`,
    );
  }
  const asset = releaseJson.assets.find((a) => a.name === filename);
  if (asset === undefined) {
    throw new Error(
      `release ${tag} has no asset named ${filename}; available: ${releaseJson.assets.map((a) => a.name).join(", ")}`,
    );
  }
  const assetRes = await githubRequest(token, "GET", asset.url, {
    headers: { accept: "application/octet-stream" },
  });
  if (!assetRes.ok) {
    const errText = await assetRes.text();
    throw new Error(
      `GitHub asset download for ${filename} failed: ${String(assetRes.status)} ${assetRes.statusText}: ${errText}`,
    );
  }
  const buf = Buffer.from(await assetRes.arrayBuffer());
  if (buf.length === 0) {
    throw new Error(
      `GitHub asset download for ${filename} returned empty payload`,
    );
  }
  return buf;
}

export async function fetchArtifact(
  tag: string,
  filename: string,
): Promise<Buffer> {
  assertNonBlank("tag", tag);
  assertNonBlank("filename", filename);

  if (await hasGhCli()) {
    return fetchArtifactViaGh(tag, filename);
  }
  return fetchArtifactViaRest(tag, filename);
}

function validateArtifacts(artifacts: ReleaseArtifact[]): void {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("publishRelease: artifacts must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const a of artifacts) {
    assertNonBlank("artifact.name", a.name);
    if (!Buffer.isBuffer(a.bytes) || a.bytes.length === 0) {
      throw new Error(
        `publishRelease: artifact ${a.name} bytes must be a non-empty Buffer`,
      );
    }
    if (!Buffer.isBuffer(a.gpgSig) || a.gpgSig.length === 0) {
      throw new Error(
        `publishRelease: artifact ${a.name} gpgSig must be a non-empty Buffer`,
      );
    }
    if (seen.has(a.name)) {
      throw new Error(`publishRelease: duplicate artifact name ${a.name}`);
    }
    seen.add(a.name);
  }
}

async function publishReleaseViaGh(
  tag: string,
  artifacts: ReleaseArtifact[],
): Promise<URL> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "flex-release-"));
  try {
    const filePaths: string[] = [];
    for (const a of artifacts) {
      const dataPath = path.join(stageDir, a.name);
      await fs.writeFile(dataPath, a.bytes);
      filePaths.push(dataPath);

      const sigPath = path.join(stageDir, `${a.name}.asc`);
      await fs.writeFile(sigPath, a.gpgSig);
      filePaths.push(sigPath);
    }

    const createProc = Bun.spawn(
      [GH_BIN, "release", "create", tag, "--notes", `Flex release ${tag}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [createOutText, createErrText, createCode] = await Promise.all([
      new Response(createProc.stdout).text(),
      new Response(createProc.stderr).text(),
      createProc.exited,
    ]);
    if (createCode !== 0) {
      throw new Error(
        `gh release create ${tag} failed with code ${String(createCode)}: ${createErrText}`,
      );
    }

    const uploadProc = Bun.spawn(
      [GH_BIN, "release", "upload", tag, ...filePaths, "--clobber"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [, uploadErrText, uploadCode] = await Promise.all([
      new Response(uploadProc.stdout).text(),
      new Response(uploadProc.stderr).text(),
      uploadProc.exited,
    ]);
    if (uploadCode !== 0) {
      throw new Error(
        `gh release upload ${tag} failed with code ${String(uploadCode)}: ${uploadErrText}`,
      );
    }

    const viewProc = Bun.spawn(
      [GH_BIN, "release", "view", tag, "--json", "url"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [viewOutText, viewErrText, viewCode] = await Promise.all([
      new Response(viewProc.stdout).text(),
      new Response(viewProc.stderr).text(),
      viewProc.exited,
    ]);
    if (viewCode !== 0) {
      throw new Error(
        `gh release view ${tag} failed with code ${String(viewCode)}: ${viewErrText}`,
      );
    }
    const viewJson = JSON.parse(viewOutText) as unknown;
    if (
      typeof viewJson !== "object" ||
      viewJson === null ||
      typeof (viewJson as { url?: unknown }).url !== "string"
    ) {
      throw new Error(
        `gh release view ${tag} returned unexpected payload: ${viewOutText}`,
      );
    }
    const urlStr = (viewJson as { url: string }).url;
    // Surface trailing stdout from create for callers without echoing secrets.
    void createOutText;
    return new URL(urlStr);
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

async function publishReleaseViaRest(
  tag: string,
  artifacts: ReleaseArtifact[],
): Promise<URL> {
  const token = requireGithubToken();
  const { owner, repo } = detectRepoFromGitRemote();

  const createRes = await githubRequest(
    token,
    "POST",
    `${GITHUB_API}/repos/${owner}/${repo}/releases`,
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        body: `Flex release ${tag}`,
      }),
    },
  );
  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(
      `GitHub create-release for ${tag} failed: ${String(createRes.status)} ${createRes.statusText}: ${errText}`,
    );
  }
  const createJson: unknown = await createRes.json();
  if (!isGithubReleaseResponse(createJson)) {
    throw new Error(
      `GitHub create-release payload missing expected fields: ${JSON.stringify(createJson)}`,
    );
  }

  // `upload_url` follows RFC 6570: `https://.../releases/<id>/assets{?name,label}`.
  const uploadBase = createJson.upload_url.replace(/\{\?[^}]+\}$/, "");

  const uploads: { name: string; buf: Buffer }[] = [];
  for (const a of artifacts) {
    uploads.push({ name: a.name, buf: a.bytes });
    uploads.push({ name: `${a.name}.asc`, buf: a.gpgSig });
  }
  for (const u of uploads) {
    const uploadUrl = `${uploadBase}?name=${encodeURIComponent(u.name)}`;
    const uploadRes = await githubRequest(token, "POST", uploadUrl, {
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(u.buf),
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(
        `GitHub upload of ${u.name} failed: ${String(uploadRes.status)} ${uploadRes.statusText}: ${errText}`,
      );
    }
  }

  return new URL(createJson.html_url);
}

export async function publishRelease(
  tag: string,
  artifacts: ReleaseArtifact[],
): Promise<URL> {
  assertNonBlank("tag", tag);
  validateArtifacts(artifacts);

  if (await hasGhCli()) {
    return publishReleaseViaGh(tag, artifacts);
  }
  return publishReleaseViaRest(tag, artifacts);
}
