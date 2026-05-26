import { PublicKey } from "@solana/web3.js";

// Endpoint and payload shape confirmed against
// https://github.com/solana-foundation/solana-verifiable-build/blob/master/src/api/client.rs
// (`REMOTE_SERVER_URL` + `/verify-with-signer` POST).
const OTTERSEC_REMOTE_SERVER_URL = "https://verify.osec.io";
const SUBMIT_JOB_PATH = "/verify-with-signer";

declare const jobIdBrand: unique symbol;
export type JobId = string & { readonly [jobIdBrand]: "JobId" };

type VerifyResponse = {
  status: string;
  request_id: string;
  message: string;
};

function isVerifyResponse(value: unknown): value is VerifyResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.status === "string" &&
    typeof v.request_id === "string" &&
    typeof v.message === "string"
  );
}

function assertNonBlank(name: string, value: string): void {
  if (value.length === 0 || value.trim().length === 0) {
    throw new Error(`submitVerifyJob: ${name} must be a non-blank string`);
  }
}

// `commitHash` is the canonical pin: OtterSec verifies the build
// against exactly that commit. The argument is required (rather than
// defaulting to "") because an empty hash makes OtterSec fall back to
// HEAD of the configured branch, producing an unpinned verification
// record whose meaning drifts as the branch advances. Callers must
// pass the commit being deployed (e.g. `git rev-parse <tag>^{}` for
// a tagged release) so the record on file matches the deployed bytes.
export async function submitVerifyJob(
  uploader: PublicKey,
  programId: PublicKey,
  repoUrl: string,
  commitHash: string,
): Promise<JobId> {
  assertNonBlank("repoUrl", repoUrl);
  assertNonBlank("commitHash", commitHash);

  let parsedRepoUrl: URL;
  try {
    parsedRepoUrl = new URL(repoUrl);
  } catch (cause) {
    throw new Error(`submitVerifyJob: repoUrl is not a valid URL: ${repoUrl}`, {
      cause,
    });
  }
  if (
    parsedRepoUrl.protocol !== "https:" &&
    parsedRepoUrl.protocol !== "http:"
  ) {
    throw new Error(
      `submitVerifyJob: repoUrl must use http(s); got ${parsedRepoUrl.protocol}`,
    );
  }

  const endpoint = `${OTTERSEC_REMOTE_SERVER_URL}${SUBMIT_JOB_PATH}`;
  const body = JSON.stringify({
    program_id: programId.toBase58(),
    signer: uploader.toBase58(),
    repository: parsedRepoUrl.toString(),
    commit_hash: commitHash,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `OtterSec submit-job request failed: ${String(response.status)} ${response.statusText}: ${errText}`,
    );
  }

  const raw: unknown = await response.json();
  if (!isVerifyResponse(raw)) {
    throw new Error(
      `OtterSec submit-job returned unexpected payload: ${JSON.stringify(raw)}`,
    );
  }
  if (raw.request_id.length === 0) {
    throw new Error(
      `OtterSec submit-job returned an empty request_id: ${JSON.stringify(raw)}`,
    );
  }
  return raw.request_id as JobId;
}
