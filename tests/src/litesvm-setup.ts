import { LiteSVM } from "litesvm";
import { PublicKey } from "@solana/web3.js";
import { FLEX_PROGRAM_ADDRESS } from "@faremeter/flex-solana";

const PROGRAM_SO_PATH = "target/deploy/flex.so";

export function createTestSVM(): LiteSVM {
  return new LiteSVM()
    .withSysvars()
    .withDefaultPrograms()
    .withPrecompiles()
    .withBlockhashCheck(false)
    .withTransactionHistory(0n);
}

export function initTestSVM(): LiteSVM {
  const svm = createTestSVM();
  svm.addProgramFromFile(new PublicKey(FLEX_PROGRAM_ADDRESS), PROGRAM_SO_PATH);
  svm.warpToSlot(1n);
  return svm;
}
