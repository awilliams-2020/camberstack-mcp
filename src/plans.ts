/** What the paid plan costs and includes: the one copy every page, email and tool reads. */

export const PRO_PRICE_LABEL = "$49/month";
/** What Pro includes besides unlimited applies, in public copy. One per subscriber. */
export const PRO_SESSION = "one 30-minute call with me, or a written review of your ads";
const CONTACT = "adam@camberstack.io";
/** The Google account subscribers grant Read-only access to; Google's invitation names their account. */
const REVIEWER = "camberstack@gmail.com";

/**
 * How a subscriber claims the session. Only on pages a paying user sees, so the booking link stays private.
 * The review needs read-only access granted in Google Ads, never the subscriber's Camberstack token.
 */
export function proSessionHtml(bookingUrl?: string): string {
  const call = bookingUrl
    ? `<a href="${bookingUrl}">Book a time</a> that suits you.`
    : `Email <a href="mailto:${CONTACT}">${CONTACT}</a> and we'll find a time.`;
  return `<p><strong>Included with Pro: one session with me (Adam).</strong> Pick either:</p>
<ul>
<li><strong>A 30-minute call</strong> to get you connected and go through your ads together. ${call}</li>
<li><strong>A written review of your ads</strong> within 2 days: your conversion tracking, where the money goes, and 5–10 fixes
you can paste straight into your AI. To ask for it, open <em>Admin → Access and security</em> in Google Ads and add
<strong>${REVIEWER}</strong> with <em>Read only</em> access. That's all: Google's invitation tells me which account. The review
comes to the email you use for Camberstack, and you can remove the access whenever you like.</li>
</ul>`;
}
