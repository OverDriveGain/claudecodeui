/**
 * BTI login-token email sender.
 *
 * Pluggable + dependency-free. In order of preference:
 *   1. RESEND_API_KEY set  → send via the Resend HTTP API (global fetch, no npm dep).
 *   2. otherwise (dev)     → log the token to the server console and report
 *                            `delivered: false` so the route can surface a dev token.
 *
 * SMTP can be added later (needs nodemailer, which isn't installed on this box).
 * Real inbox delivery in prod requires RESEND_API_KEY (or equivalent) — until
 * then the flow still works end-to-end via the dev token path.
 */

const FROM = process.env.LOGIN_EMAIL_FROM || 'bldr <onboarding@kikhia.ae>';
const APP_NAME = process.env.APP_NAME || 'bldr';

export interface SendLoginTokenResult {
  /** true if the token was actually handed to a real email provider. */
  delivered: boolean;
  /** populated only when NOT delivered AND not in production (dev convenience). */
  devToken?: string;
}

export async function sendLoginToken(email: string, token: string): Promise<SendLoginTokenResult> {
  const resendKey = process.env.RESEND_API_KEY;
  const isProd = process.env.NODE_ENV === 'production';

  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM,
          to: [email],
          subject: `Your ${APP_NAME} login token`,
          text: `Your ${APP_NAME} login token is:\n\n${token}\n\n`
            + `Paste it into the chat to sign in. Keep it — it is your login for next time.`,
          html: `<p>Your <strong>${APP_NAME}</strong> login token is:</p>`
            + `<p style="font-size:16px;font-family:monospace;word-break:break-all;background:#f4f4f5;padding:12px;border-radius:8px">${token}</p>`
            + `<p>Paste it into the chat to sign in. <strong>Keep it</strong> — it is your login for next time.</p>`,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error('[login-email] Resend send failed', res.status, detail);
        return { delivered: false, devToken: isProd ? undefined : token };
      }
      return { delivered: true };
    } catch (err) {
      console.error('[login-email] Resend send error', err);
      return { delivered: false, devToken: isProd ? undefined : token };
    }
  }

  // Dev fallback — no provider configured.
  console.log(`[login-email] (dev, no email provider) token for ${email}: ${token}`);
  return { delivered: false, devToken: isProd ? undefined : token };
}
