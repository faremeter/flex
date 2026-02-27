import { rootNodeFromAnchor } from "@codama/nodes-from-anchor";
import { renderVisitor } from "@codama/renderers-js";
import { createFromRoot, updateInstructionsVisitor } from "codama";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const idlPath = path.join(root, "target/idl/flex.json");
const outDir = path.join(root, "packages/flex-solana");

const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
const rootNode = rootNodeFromAnchor(idl);
const codama = createFromRoot(rootNode);

// Several instructions have PDA seeds that reference themselves (the Anchor
// IDL encodes `session_key_account.key` as just `session_key_account`). Remove
// the auto-derived default so callers pass the address explicitly.
codama.update(
  updateInstructionsVisitor({
    closeSessionKey: {
      accounts: { sessionKeyAccount: { defaultValue: null } },
    },
    revokeSessionKey: {
      accounts: { sessionKeyAccount: { defaultValue: null } },
    },
    submitAuthorization: {
      accounts: { sessionKey: { defaultValue: null } },
    },
  }),
);

codama.accept(renderVisitor(outDir));
