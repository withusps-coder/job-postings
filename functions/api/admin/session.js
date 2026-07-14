import { authenticateAdminRequest } from "../../_lib/access.js";
import { getCsrfSigningSecret, issueAdminCsrfToken } from "../../_lib/csrf.js";
import { adminError, adminJson } from "../../_lib/errors.js";

/**
 * Issues a fresh, subject-bound CSRF token for the protected admin mutation
 * family. It verifies the Access assertion itself so this handler never trusts
 * an unverified context value.
 *
 * @param {EventContext<Record<string, unknown>, string, unknown>} context
 * @returns {Promise<Response>}
 */
export async function onRequestGet(context) {
  const authentication = await authenticateAdminRequest(
    context.request,
    context.env,
  );
  if (!authentication.ok) return adminError(authentication.code);
  const { admin } = authentication;

  let csrfSigningSecret;
  try {
    csrfSigningSecret = getCsrfSigningSecret(context.env);
  } catch {
    return adminError("ADMIN_UNAVAILABLE");
  }

  try {
    const csrf = await issueAdminCsrfToken({
      subject: admin.subject,
      secret: csrfSigningSecret,
    });
    return adminJson({
      admin: { email: admin.email },
      csrfToken: csrf.token,
      expiresAt: csrf.expiresAt,
    });
  } catch {
    return adminError("ADMIN_UNAVAILABLE");
  }
}
