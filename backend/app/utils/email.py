import asyncio
import smtplib
from email.message import EmailMessage

from app.config import settings


def _send_via_gmail_smtp(to_email: str, reset_url: str) -> None:
    """Synchronous — smtplib has no async API. Called through asyncio.to_thread so a slow SMTP
    handshake can't stall the event loop for every other request this worker is handling."""
    message = EmailMessage()
    message["Subject"] = "Reset your Relay password"
    message["From"] = settings.GMAIL_ADDRESS
    message["To"] = to_email
    message.set_content(
        "Someone requested a password reset for your Relay account.\n\n"
        f"Reset it here (expires in 30 minutes): {reset_url}\n\n"
        "If you didn't request this, you can safely ignore this email."
    )
    message.add_alternative(
        "<p>Someone requested a password reset for your Relay account.</p>"
        f'<p><a href="{reset_url}">Click here to reset your password</a> '
        "(this link expires in 30 minutes).</p>"
        "<p>If you didn't request this, you can safely ignore this email.</p>",
        subtype="html",
    )

    with smtplib.SMTP("smtp.gmail.com", 587, timeout=10) as smtp:
        smtp.starttls()
        smtp.login(settings.GMAIL_ADDRESS, settings.GMAIL_APP_PASSWORD)
        smtp.send_message(message)


async def send_password_reset_email(to_email: str, reset_url: str) -> None:
    """Sends the reset link over Gmail's SMTP relay, authenticated with an App Password (never
    the account's real login password — see config.py). Chosen after both Resend and Mailgun's
    free tiers turned out to require either a verified domain or a pre-authorized recipient list
    to deliver anywhere but a fixed, narrow set of addresses (see INTERVIEW_GUIDE.md for the full
    story) — Gmail SMTP has no such restriction and can send to any real inbox at zero cost.
    If no App Password is configured, falls back to logging the link instead — the same
    zero-infra-for-local-dev philosophy as REDIS_URL=fake: this feature should be fully testable
    without requiring a real Google account.
    Deliberately never raises: a flaky/misconfigured mail relay must not turn "forgot password"
    into a 500 for the user, and the caller already treats "email sent" as fire-and-forget so it
    can return the same generic response whether or not the account even exists.
    """
    if not settings.GMAIL_ADDRESS or not settings.GMAIL_APP_PASSWORD:
        # `print`, not a logging call — this app never configures Python's logging module, so
        # anything below the "no handler configured" default (which only surfaces WARNING and
        # above) would be silently dropped. Learned this the hard way on this exact feature: a
        # failed send and a successful one looked identical in the logs before this was `print`.
        print(f"[dev] Password reset link for {to_email}: {reset_url}")
        return

    try:
        await asyncio.to_thread(_send_via_gmail_smtp, to_email, reset_url)
        print(f"Password reset email sent to {to_email} via Gmail SMTP")
    except Exception as err:
        print(f"Failed to send password reset email to {to_email}: {err!r}")
