/**
 * Centralized Admin Roles & Authorization
 * Defines authorized administrator emails, role verification functions,
 * and cryptographically secured master password checks.
 */

import crypto from "crypto";

export const ADMIN_EMAILS: string[] = [
  "souftoolsai@gmail.com",
  "lrsoufyane2007@gmail.com",
  "souftoolsheb@gmail.com",
  "toolssouf@gmail.com",
  "aqurivo@gmail.com",
];

// Default SHA-256 hash for master admin access
const ADMIN_MASTER_PASSWORD_HASH_DEFAULT =
  "330169c140dad019caf14c1612c19ba198dd8388127e82072e884ecb54524d08";

/**
 * Checks if a given email belongs to an authorized super administrator.
 */
export function isUserAdmin(email?: string | null): boolean {
  if (!email) return false;
  const clean = email.trim().toLowerCase();
  const envAdmin = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (envAdmin && clean === envAdmin) return true;
  return ADMIN_EMAILS.some((adm) => adm.toLowerCase() === clean);
}

/**
 * Verifies if the provided password matches the encrypted/hashed master admin password.
 */
export function verifyAdminMasterPassword(inputPassword?: string | null): boolean {
  if (!inputPassword) return false;
  try {
    const inputHash = crypto.createHash("sha256").update(inputPassword.trim()).digest("hex");
    const targetHash =
      process.env.ADMIN_MASTER_PASSWORD_HASH || ADMIN_MASTER_PASSWORD_HASH_DEFAULT;
    
    // Constant time comparison to prevent timing attacks
    return (
      inputHash.length === targetHash.length &&
      crypto.timingSafeEqual(Buffer.from(inputHash, "hex"), Buffer.from(targetHash, "hex"))
    );
  } catch {
    return false;
  }
}

/**
 * Resolves the role title for display and access control
 */
export function getUserRole(email?: string | null): "super_admin" | "admin" | "user" {
  if (isUserAdmin(email)) {
    return "super_admin";
  }
  return "user";
}

