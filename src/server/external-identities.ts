import "server-only";
import { randomUUID } from "node:crypto";
import { pool, transaction } from "./repository";
import type { ProductionAuthConfig } from "./auth-config";

const githubSubjectPattern = /^[1-9][0-9]{0,19}$/;
const githubLoginPattern = /^[A-Za-z0-9-]{1,39}$/;

export type GithubIdentity = {
  subject: string;
  /** Non-authoritative account label. It is never used for authorization. */
  login: string;
};

export type ExternalIdentityRecord = GithubIdentity & { userId: string };

export class IdentityProvisioningError extends Error {
  constructor() {
    super("identity provisioning failed");
    this.name = "IdentityProvisioningError";
  }
}

/**
 * Uses GitHub's stable numeric account ID, not e-mail/name, as the identity
 * subject. A number must be safe before stringification so JavaScript cannot
 * silently round an identity value.
 */
export function githubIdentityFromProfile(
  profile: unknown,
): GithubIdentity | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as { id?: unknown; login?: unknown };
  const subject =
    typeof record.id === "string"
      ? record.id
      : typeof record.id === "number" && Number.isSafeInteger(record.id)
        ? String(record.id)
        : null;
  if (!subject || !githubSubjectPattern.test(subject)) return null;
  const login =
    typeof record.login === "string" && githubLoginPattern.test(record.login)
      ? record.login
      : "GitHub-account";
  return { subject, login };
}

function syntheticIdentityEmail(subject: string): string {
  // `users.email` predates external identity support and is required/non-null.
  // This non-routable technical value is never used to find or authorize users.
  return `github-${subject}@identity.invalid`;
}

async function requiredBusiness(db: { query: typeof pool.query }, id: string) {
  const result = await db.query("SELECT 1 FROM businesses WHERE id=$1", [id]);
  if (!result.rowCount) throw new IdentityProvisioningError();
}

/**
 * Atomically creates a one-time GitHub identity binding. Initial role grants
 * are possible only from an explicit, validated environment policy and only
 * while the mapping is first created. Existing/disabled memberships are never
 * enabled, upgraded, or otherwise changed by a later OAuth login.
 */
export async function provisionGithubIdentity(
  identity: GithubIdentity,
  config: ProductionAuthConfig,
): Promise<ExternalIdentityRecord> {
  if (!githubSubjectPattern.test(identity.subject))
    throw new IdentityProvisioningError();
  return transaction(async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `github:${identity.subject}`,
    ]);
    const existing = await db.query<{
      subject: string;
      display_name: string;
      user_id: string;
    }>(
      "SELECT subject,display_name,user_id FROM external_identities WHERE provider='github' AND subject=$1",
      [identity.subject],
    );
    if (existing.rowCount) {
      const record = existing.rows[0];
      return {
        subject: record.subject,
        login: record.display_name,
        userId: record.user_id,
      };
    }

    const administrator = config.administratorGithubSubjects.has(
      identity.subject,
    );
    const initialMembership = administrator
      ? { businessId: config.administratorBusinessId, role: "admin" as const }
      : config.publicDemo
        ? { businessId: config.publicDemo.businessId, role: "viewer" as const }
        : null;
    if (initialMembership)
      await requiredBusiness(db, initialMembership.businessId);

    const userId = randomUUID();
    try {
      await db.query("INSERT INTO users(id,email) VALUES($1,$2)", [
        userId,
        syntheticIdentityEmail(identity.subject),
      ]);
      await db.query(
        "INSERT INTO external_identities(provider,subject,user_id,display_name) VALUES('github',$1,$2,$3)",
        [identity.subject, userId, identity.login],
      );
      if (initialMembership)
        await db.query(
          "INSERT INTO memberships(business_id,user_id,role,status) VALUES($1,$2,$3,'active')",
          [initialMembership.businessId, userId, initialMembership.role],
        );
    } catch {
      // The API/Auth.js callback never receives a database/constraint detail.
      throw new IdentityProvisioningError();
    }
    return { ...identity, userId };
  });
}

export async function findGithubIdentity(
  subject: string,
): Promise<ExternalIdentityRecord | null> {
  if (!githubSubjectPattern.test(subject)) return null;
  const result = await pool.query<{
    subject: string;
    display_name: string;
    user_id: string;
  }>(
    "SELECT subject,display_name,user_id FROM external_identities WHERE provider='github' AND subject=$1",
    [subject],
  );
  if (!result.rowCount) return null;
  const identity = result.rows[0];
  return {
    subject: identity.subject,
    login: identity.display_name,
    userId: identity.user_id,
  };
}
