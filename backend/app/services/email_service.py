"""Email service supporting SMTP delivery and isolated test mailbox."""

from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import logging
from typing import Any

from app.config import get_settings

logger = logging.getLogger(__name__)


class TestMailbox:
    """Isolated in-process test mailbox for testing when SMTP is unconfigured."""

    _messages: list[dict[str, Any]] = []

    @classmethod
    def _get_file_path(cls) -> str:
        import os
        from pathlib import Path

        custom = os.environ.get("TEST_MAILBOX_PATH")
        if custom:
            return custom
        try:
            settings = get_settings()
            base = Path(settings.storage_path).resolve().parent
            base.mkdir(parents=True, exist_ok=True)
            return str(base / "test_mailbox.json")
        except Exception:
            return "/tmp/zhiyi-pg/test_mailbox.json"

    @classmethod
    def record(cls, to_email: str, subject: str, code: str, purpose: str) -> None:
        import json
        import os

        entry = {
            "to_email": to_email,
            "subject": subject,
            "code": code,
            "purpose": purpose,
        }
        cls._messages.append(entry)
        file_path = cls._get_file_path()
        try:
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            records = []
            if os.path.exists(file_path):
                with open(file_path, "r", encoding="utf-8") as f:
                    records = json.load(f)
            records.append(entry)
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(records, f, ensure_ascii=False)
        except Exception:
            pass

    @classmethod
    def get_latest_code(cls, to_email: str, purpose: str | None = None) -> str | None:
        import json
        import os

        for msg in reversed(cls._messages):
            if msg["to_email"].lower() == to_email.lower():
                if purpose is None or msg.get("purpose") == purpose:
                    return msg["code"]
        file_path = cls._get_file_path()
        if os.path.exists(file_path):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    records = json.load(f)
                for msg in reversed(records):
                    if msg["to_email"].lower() == to_email.lower():
                        if purpose is None or msg.get("purpose") == purpose:
                            return msg["code"]
            except Exception:
                pass
        return None

    @classmethod
    def clear(cls) -> None:
        import os

        cls._messages.clear()
        file_path = cls._get_file_path()
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass


class EmailService:
    def __init__(self) -> None:
        self.settings = get_settings()

    @property
    def is_smtp_configured(self) -> bool:
        return bool(self.settings.smtp_host and self.settings.smtp_user)

    async def send_verification_code(
        self, to_email: str, code: str, purpose: str
    ) -> dict[str, Any]:
        """Send verification code via SMTP or route to test mailbox."""
        if purpose == "register":
            subject = "【知衣】注册验证码"
            intro = "您正在注册知衣账号，验证码如下："
        elif purpose == "reset_password":
            subject = "【知衣】找回密码验证码"
            intro = "您正在申请重置知衣账号密码，验证码如下："
        else:
            subject = "【知衣】安全验证码"
            intro = "您的安全验证码如下："

        body_text = (
            f"您好！\n\n{intro}\n\n"
            f"【{code}】\n\n"
            f"验证码在 10 分钟内有效。如非本人操作，请忽略此邮件。\n\n"
            f"知衣 Wardrobe 团队"
        )

        body_html = f"""
        <div style="max-width: 520px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; border: 1px solid #E5E7EB; border-radius: 8px;">
            <h2 style="color: #111827; margin-top: 0;">知衣 Wardrobe</h2>
            <p style="color: #4B5563; font-size: 15px;">{intro}</p>
            <div style="background-color: #F3F4F6; padding: 16px; border-radius: 6px; text-align: center; margin: 20px 0;">
                <span style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #1D4ED8;">{code}</span>
            </div>
            <p style="color: #6B7280; font-size: 13px;">验证码将在 10 分钟后失效，请勿转告他人。</p>
            <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 20px 0;" />
            <p style="color: #9CA3AF; font-size: 12px; margin-bottom: 0;">如非本人操作，请忽略本邮件。</p>
        </div>
        """

        if not self.is_smtp_configured:
            # Route to isolated test mailbox - do not print code to production log
            TestMailbox.record(to_email, subject, code, purpose)
            logger.info("Test mailbox received verification code for %s (purpose: %s)", to_email, purpose)
            return {
                "sent": True,
                "mode": "test_mailbox",
                "message": "测试发信通过、真实邮件待配置",
            }

        # Real SMTP delivery via aiosmtplib
        try:
            import aiosmtplib

            msg = MIMEMultipart("alternative")
            from_email = self.settings.smtp_user
            msg["From"] = from_email
            msg["To"] = to_email
            msg["Subject"] = subject
            msg.attach(MIMEText(body_text, "plain", "utf-8"))
            msg.attach(MIMEText(body_html, "html", "utf-8"))

            await aiosmtplib.send(
                msg,
                hostname=self.settings.smtp_host,
                port=self.settings.smtp_port,
                username=self.settings.smtp_user,
                password=self.settings.smtp_password,
                start_tls=True,
            )
            return {
                "sent": True,
                "mode": "smtp",
                "message": "邮件已送达",
            }
        except Exception as e:
            logger.error("Failed to send email via SMTP to %s: %s", to_email, e)
            return {
                "sent": False,
                "mode": "smtp",
                "message": f"发信失败: {str(e)}",
            }
