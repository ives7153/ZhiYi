from datetime import UTC, datetime, timedelta
import uuid
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.auth_code import AuthVerificationCode
from app.models.user import User
from app.schemas.user import UserCreate, UserSyncRequest, UserUpdate
from app.utils.security import (
    generate_numeric_code,
    hash_code,
    hash_password,
    verify_code,
    verify_password,
)


class UserEmailConflictError(Exception):
    pass


class CodeRateLimitError(Exception):
    pass


class InvalidCodeError(Exception):
    pass


class AuthenticationFailedError(Exception):
    pass


class AccountInactiveError(Exception):
    pass


class EmailNotVerifiedError(Exception):
    pass


class PasswordNotSetError(Exception):
    pass


class UserService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_by_id(self, user_id: UUID) -> User | None:
        result = await self.db.execute(select(User).where(User.id == user_id))
        return result.scalar_one_or_none()

    async def get_by_external_id(
        self, external_id: str, load_preferences: bool = True
    ) -> User | None:
        query = select(User).where(User.external_id == external_id)

        if load_preferences:
            query = query.options(selectinload(User.preferences))

        result = await self.db.execute(query)
        return result.scalar_one_or_none()

    async def get_by_email(self, email: str) -> User | None:
        norm_email = email.strip().lower()
        result = await self.db.execute(select(User).where(func.lower(User.email) == norm_email))
        return result.scalar_one_or_none()

    async def create(self, user_data: UserCreate) -> User:
        user = User(
            external_id=user_data.external_id,
            email=user_data.email.strip().lower(),
            display_name=user_data.display_name,
            avatar_url=user_data.avatar_url,
            timezone=user_data.timezone,
            locale=user_data.locale,
            location_lat=user_data.location_lat,
            location_lon=user_data.location_lon,
            location_name=user_data.location_name,
        )
        self.db.add(user)
        await self.db.flush()
        await self.db.refresh(user)
        return user

    async def update(self, user: User, user_data: UserUpdate) -> User:
        update_data = user_data.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(user, field, value)
        await self.db.flush()
        await self.db.refresh(user)
        return user

    async def sync_from_oidc(self, sync_data: UserSyncRequest) -> tuple[User, bool]:
        """Sync user from OIDC provider."""
        user = await self.get_by_external_id(sync_data.external_id)
        effective_email = sync_data.email.strip().lower() if sync_data.email else ""

        if user is None:
            existing_by_email = await self.get_by_email(effective_email) if effective_email else None
            if existing_by_email is not None:
                existing_by_email.external_id = sync_data.external_id
                existing_by_email.display_name = sync_data.display_name
                if sync_data.avatar_url:
                    existing_by_email.avatar_url = sync_data.avatar_url
                existing_by_email.last_login_at = datetime.now(UTC)
                await self.db.flush()
                await self.db.refresh(existing_by_email)
                return existing_by_email, False

            user = User(
                external_id=sync_data.external_id,
                email=effective_email,
                display_name=sync_data.display_name,
                avatar_url=sync_data.avatar_url,
                last_login_at=datetime.now(UTC),
                email_verified=True,  # OIDC verified
            )
            self.db.add(user)
            await self.db.flush()
            await self.db.refresh(user)
            return user, True
        else:
            if effective_email and user.email.lower() != effective_email:
                existing_by_email = await self.get_by_email(effective_email)
                if existing_by_email is not None and existing_by_email.id != user.id:
                    raise UserEmailConflictError(
                        f"Cannot update email to {effective_email}: already in use by another account."
                    )

            if effective_email:
                user.email = effective_email
            user.display_name = sync_data.display_name
            if sync_data.avatar_url:
                user.avatar_url = sync_data.avatar_url
            user.last_login_at = datetime.now(UTC)
            await self.db.flush()
            await self.db.refresh(user)
            return user, False

    async def register_local(
        self, email: str, password: str, display_name: str | None = None
    ) -> User:
        """Register a new user with email and password."""
        norm_email = email.strip().lower()
        existing = await self.get_by_email(norm_email)
        if existing is not None:
            raise UserEmailConflictError("该邮箱已被注册")

        name = (display_name or "").strip() or norm_email.split("@")[0]
        hashed = hash_password(password)

        user = User(
            external_id=f"local:{uuid.uuid4()}",
            email=norm_email,
            display_name=name,
            password_hash=hashed,
            email_verified=True,  # Code was verified prior to registration
            token_version=1,
            last_login_at=datetime.now(UTC),
        )
        self.db.add(user)
        try:
            await self.db.flush()
        except IntegrityError:
            await self.db.rollback()
            raise UserEmailConflictError("该邮箱已被注册") from None
        await self.db.refresh(user)
        return user

    async def authenticate_local(self, email: str, password: str) -> User:
        """Authenticate user by email and password with unified timing-safe behavior."""
        norm_email = email.strip().lower()
        user = await self.get_by_email(norm_email)

        # Constant dummy verification to prevent timing side channels when user doesn't exist
        dummy_hash = "$argon2id$v=19$m=65536,t=2,p=4$dGVzdHNhbHQxMjM0NQ$dGVzdGtleTEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI"
        if user is None or not user.password_hash:
            verify_password(password, dummy_hash)
            raise AuthenticationFailedError("邮箱或密码错误")

        if not verify_password(password, user.password_hash):
            raise AuthenticationFailedError("邮箱或密码错误")

        if not user.is_active:
            raise AccountInactiveError("账号已被停用，请联系管理员")

        if not user.email_verified:
            raise EmailNotVerifiedError("邮箱尚未验证，请先完成邮箱验证")

        user.last_login_at = datetime.now(UTC)
        await self.db.flush()
        return user

    async def update_password(self, user: User, new_password: str) -> None:
        """Update password and increment token_version to invalidate all prior tokens."""
        user.password_hash = hash_password(new_password)
        user.token_version = (user.token_version or 1) + 1
        await self.db.flush()

    async def revoke_sessions(self, user: User) -> None:
        """Revoke all active tokens by incrementing token_version."""
        user.token_version = (user.token_version or 1) + 1
        await self.db.flush()

    async def create_verification_code(self, email: str, purpose: str) -> str:
        """Create a verification code with rate-limiting."""
        norm_email = email.strip().lower()

        # Check rate-limit (60 seconds)
        recent_q = (
            select(AuthVerificationCode)
            .where(
                func.lower(AuthVerificationCode.email) == norm_email,
                AuthVerificationCode.purpose == purpose,
            )
            .order_by(AuthVerificationCode.created_at.desc())
            .limit(1)
        )
        recent_res = await self.db.execute(recent_q)
        recent = recent_res.scalar_one_or_none()
        now = datetime.now(UTC)
        if recent is not None:
            # If created less than 60 seconds ago, rate-limit
            time_diff = (now - recent.created_at).total_seconds()
            if time_diff < 60:
                raise CodeRateLimitError("验证码请求过于频繁，请稍候再试")

        code = generate_numeric_code(6)
        c_hash = hash_code(code)
        expires_at = now + timedelta(minutes=10)

        record = AuthVerificationCode(
            email=norm_email,
            code_hash=c_hash,
            purpose=purpose,
            expires_at=expires_at,
        )
        self.db.add(record)
        await self.db.flush()
        return code

    async def verify_and_consume_code(self, email: str, code: str, purpose: str) -> bool:
        """Verify code against active records and consume atomically."""
        norm_email = email.strip().lower()
        now = datetime.now(UTC)

        q = (
            select(AuthVerificationCode)
            .where(
                func.lower(AuthVerificationCode.email) == norm_email,
                AuthVerificationCode.purpose == purpose,
                AuthVerificationCode.is_used.is_(False),
                AuthVerificationCode.expires_at > now,
            )
            .order_by(AuthVerificationCode.created_at.desc())
            .limit(1)
            .with_for_update()
        )
        res = await self.db.execute(q)
        record = res.scalar_one_or_none()

        if record is None:
            raise InvalidCodeError("验证码无效或已过期")

        if record.attempts >= record.max_attempts:
            record.is_used = True
            await self.db.flush()
            raise InvalidCodeError("验证码尝试次数超限，请重新获取")

        if not verify_code(code, record.code_hash):
            record.attempts += 1
            await self.db.flush()
            raise InvalidCodeError("验证码错误")

        # Atomic single-use consumption
        record.is_used = True
        await self.db.flush()
        return True

    async def update_last_login(self, user: User) -> None:
        user.last_login_at = datetime.now(UTC)
        await self.db.flush()

    async def complete_onboarding(self, user: User) -> None:
        user.onboarding_completed = True
        await self.db.flush()
