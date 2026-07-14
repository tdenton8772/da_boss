/**
 * A reserved, hidden test-harness user that OWNS all live-scenario agents — so
 * test runs never clutter real users' dashboards and are trivially wiped. It's
 * hidden from the admin roster and can't be offboarded. To run a real agent it
 * needs a Claude credential, so on each run we copy the requesting admin's
 * encrypted blob to it (same cipher key — no decrypt needed).
 */
import * as queries from "../db/queries.js";

export const TEST_USER_ID = "usr_test_harness";

export async function ensureTestUser(adminUserId?: string): Promise<void> {
  if (!(await queries.getUserById(TEST_USER_ID))) {
    await queries.createUser({
      id: TEST_USER_ID,
      email: "test-harness@daboss.local",
      display_name: "Test Harness",
      role: "test",
    });
  }
  // Refresh its Claude + git credentials from the admin running the test (kept
  // fresh in case the admin rotated theirs). The git one lets repo scenarios
  // clone/push/PR against the admin's repos.
  if (adminUserId) {
    const cred = await queries.getUserCredential(adminUserId);
    if (cred) {
      await queries.upsertUserCredential(TEST_USER_ID, cred.kind, { ciphertext: cred.ciphertext, nonce: cred.nonce, keyRef: cred.key_ref });
    }
    const gitCred = await queries.getUserGitCredential(adminUserId);
    if (gitCred) {
      await queries.upsertUserGitCredential(TEST_USER_ID, { ciphertext: gitCred.ciphertext, nonce: gitCred.nonce, keyRef: gitCred.key_ref });
    }
  }
}
