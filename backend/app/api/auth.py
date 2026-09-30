from datetime import UTC, datetime, timedelta
from typing import Annotated
from urllib.parse import urlencode

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.user import User
from app.schemas.auth import (
    ChangePasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    SendCodeRequest,
    SendCodeResponse,
    TokenResponse,
)
from app.schemas.user import (
    AuthConfigOIDC,
    AuthConfigResponse,
    AuthStatusResponse,
    UserResponse,
    UserSyncRequest,
    UserSyncResponse,
)
from app.services.email_service import EmailService, TestMailbox
from app.services.user_service import (
    AccountInactiveError,
    AuthenticationFailedError,
    CodeRateLimitError,
    EmailNotVerifiedError,
    InvalidCodeError,
    UserEmailConflictError,
    UserService,
)
from app.utils.auth import get_current_user
from app.utils.oidc import validate_oidc_id_token
from app.utils.rate_limit import rate_limit_by_ip
from app.utils.security import verify_password

router = APIRouter(prefix="/auth", tags=["Authentication"])
settings = get_settings()


def create_access_token(
    external_id: str,
    expires_delta: timedelta | None = None,
    token_version: int = 1,
) -> str:
    now = datetime.now(UTC)
    if expires_delta:
        expire = now + expires_delta
    else:
        expire = now + timedelta(days=7)
    to_encode = {
        "sub": external_id,
        "ver": token_version,
        "exp": expire,
        "iat": now,
    }
    return jwt.encode(to_encode, settings.secret_key, algorithm="HS256")


def _is_dev_mode() -> bool:
    return settings.debug and not _oidc_configured()


def _oidc_configured() -> bool:
    return bool(settings.oidc_issuer_url and settings.oidc_client_id)


MOBILE_APP_SCHEME = "wardrowbe"


@router.get("/mobile-callback")
async def mobile_oidc_callback(request: Request) -> RedirectResponse:
    params = dict(request.query_params)
    target = f"{MOBILE_APP_SCHEME}://auth/callback"
    if params:
        target = f"{target}?{urlencode(params)}"
    return RedirectResponse(url=target, status_code=302)


@router.get("/config", response_model=AuthConfigResponse)
async def get_auth_config() -> AuthConfigResponse:
    cur_settings = get_settings()
    oidc_enabled = bool(cur_settings.oidc_issuer_url and cur_settings.oidc_client_id)
    password_auth = not (cur_settings.oidc_only and oidc_enabled)
    return AuthConfigResponse(
        oidc=AuthConfigOIDC(
            enabled=oidc_enabled,
            issuer_url=cur_settings.oidc_issuer_url if oidc_enabled else None,
            client_id=(cur_settings.oidc_mobile_client_id or cur_settings.oidc_client_id)
            if oidc_enabled
            else None,
        ),
        dev_mode=bool(cur_settings.debug and not oidc_enabled),
        password_auth=password_auth,
        registration_enabled=bool(cur_settings.registration_enabled and password_auth),
    )

@router.get("/status", response_model=AuthStatusResponse)
async def auth_status() -> AuthStatusResponse:
    mode = settings.get_auth_mode()
    return AuthStatusResponse(configured=True, mode=mode if mode != "unknown" else "local")


@router.post("/send-code", response_model=SendCodeResponse)
async def send_verification_code(
    request: Request,
    body: SendCodeRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> SendCodeResponse:
    """Send a verification code for registration or password reset."""
    await rate_limit_by_ip(request, "auth_send_code", 10, 60)
    cur_settings = get_settings()
    if cur_settings.oidc_only and cur_settings.oidc_issuer_url and cur_settings.oidc_client_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前部署仅支持第三方 SSO 登录",
        )
    if body.purpose == "register" and not cur_settings.registration_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前已关闭新用户注册",
        )
    user_service = UserService(db)
    email_service = EmailService()
    norm_email = body.email.strip().lower()

    if body.purpose == "register":
        existing = await user_service.get_by_email(norm_email)
        if existing is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="该邮箱已被注册或关联现有账号，请直接登录",
            )

    if body.purpose == "reset_password":
        existing = await user_service.get_by_email(norm_email)
        if existing is None or not existing.password_hash:
            # Timing-safe uniform response to prevent account enumeration
            return SendCodeResponse(
                success=True,
                message="若该邮箱已注册，验证码已发送至您的邮箱",
                delivery_mode="smtp" if email_service.is_smtp_configured else "test_mailbox",
            )

    try:
        code = await user_service.create_verification_code(norm_email, body.purpose)
        await db.commit()
    except CodeRateLimitError as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(e),
        ) from None

    res = await email_service.send_verification_code(norm_email, code, body.purpose)
    return SendCodeResponse(
        success=res["sent"],
        message="验证码已发送至您的邮箱" if res["sent"] else res["message"],
        delivery_mode=res["mode"],
    )


@router.post("/register", response_model=TokenResponse)
async def register(
    request: Request,
    body: RegisterRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TokenResponse:
    """Register a new user with email, verification code, and password."""
    await rate_limit_by_ip(request, "auth_register", 5, 60)
    cur_settings = get_settings()
    if cur_settings.oidc_only and cur_settings.oidc_issuer_url and cur_settings.oidc_client_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前部署仅支持第三方 SSO 登录",
        )
    if not cur_settings.registration_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前已关闭新用户注册",
        )
    user_service = UserService(db)
    norm_email = body.email.strip().lower()
    try:
        await user_service.verify_and_consume_code(norm_email, body.code, "register")
    except InvalidCodeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from None

    try:
        user = await user_service.register_local(
            email=norm_email,
            password=body.password,
            display_name=body.display_name,
        )
        await db.commit()
        await db.refresh(user)
    except UserEmailConflictError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        ) from None

    access_token = create_access_token(user.external_id, token_version=user.token_version)
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=UserResponse.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    request: Request,
    body: LoginRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> TokenResponse:
    """Log in with email and password."""
    await rate_limit_by_ip(request, "auth_login", 10, 60)
    cur_settings = get_settings()
    if cur_settings.oidc_only and cur_settings.oidc_issuer_url and cur_settings.oidc_client_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前部署仅支持第三方 SSO 登录",
        )
    user_service = UserService(db)
    try:
        user = await user_service.authenticate_local(body.email, body.password)
        await db.commit()
        await db.refresh(user)
    except AuthenticationFailedError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="邮箱或密码错误",
        ) from None
    except AccountInactiveError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        ) from None
    except EmailNotVerifiedError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        ) from None

    access_token = create_access_token(user.external_id, token_version=user.token_version)
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        user=UserResponse.model_validate(user),
    )


@router.post("/forgot-password", response_model=SendCodeResponse)
async def forgot_password(
    request: Request,
    body: SendCodeRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> SendCodeResponse:
    """Request password reset code with uniform feedback."""
    body.purpose = "reset_password"
    return await send_verification_code(request, body, db)


@router.post("/reset-password")
async def reset_password(
    request: Request,
    body: ResetPasswordRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, str]:
    """Reset password using email verification code, revoking all existing sessions."""
    await rate_limit_by_ip(request, "auth_reset_pwd", 5, 60)
    user_service = UserService(db)
    norm_email = body.email.strip().lower()

    try:
        await user_service.verify_and_consume_code(norm_email, body.code, "reset_password")
    except InvalidCodeError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from None

    user = await user_service.get_by_email(norm_email)
    if user is None or not user.password_hash:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="该账号未启用本地密码登录，无法重置密码",
        )
    # Invalidate old sessions and update password
    await user_service.update_password(user, body.new_password)
    user.email_verified = True
    await db.commit()

    return {"detail": "密码重置成功，请使用新密码重新登录"}


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, str]:
    """Change password for authenticated user, revoking existing tokens."""
    if not current_user.password_hash:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="当前账号使用第三方身份登录，请前往对应服务修改密码",
        )

    if not verify_password(body.old_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="原密码不正确",
        )

    user_service = UserService(db)
    await user_service.update_password(current_user, body.new_password)
    await db.commit()

    return {"detail": "密码修改成功，请重新登录"}


@router.post("/logout")
async def logout(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> dict[str, str]:
    """Revoke all server sessions for the current user."""
    user_service = UserService(db)
    await user_service.revoke_sessions(current_user)
    await db.commit()
    return {"detail": "已成功退出登录，会话已撤销"}


@router.post("/sync", response_model=UserSyncResponse)
async def sync_user(
    request: Request,
    sync_data: UserSyncRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> UserSyncResponse:
    await rate_limit_by_ip(request, "auth_sync", 10, 60)
    user_service = UserService(db)

    if _is_dev_mode():
        if not sync_data.email:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="email is required",
            )
        # Security hardening: Prevent dev-mode bypass of password-protected accounts or external_id spoofing
        existing_target = await user_service.get_by_email(sync_data.email)
        if existing_target is not None:
            if existing_target.password_hash or existing_target.external_id.startswith("local:"):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="该账号已启用正式密码保护，禁止通过开发免密入口登录",
                )
            if existing_target.external_id != sync_data.external_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="身份标识与既有账号不匹配，禁止冒用他人邮箱登录",
                )
    elif _oidc_configured():
        if not sync_data.id_token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="OIDC id_token is required for authentication",
            )

        valid_audiences = [settings.oidc_client_id]
        if (
            settings.oidc_mobile_client_id
            and settings.oidc_mobile_client_id != settings.oidc_client_id
        ):
            valid_audiences.append(settings.oidc_mobile_client_id)

        try:
            oidc_claims = await validate_oidc_id_token(
                sync_data.id_token,
                settings.oidc_issuer_url,
                valid_audiences,
            )
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=str(e),
            ) from None

        if oidc_claims.get("sub") != sync_data.external_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token subject does not match external_id",
            )

        claims_email = oidc_claims.get("email", "").lower().strip()
        if sync_data.email:
            request_email = sync_data.email.lower().strip()
            if claims_email and claims_email != request_email:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Token email does not match request email",
                )
            effective_email = request_email
        elif claims_email:
            effective_email = claims_email
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No email provided by OIDC provider. Configure your provider to include the email claim.",
            )

        sync_data = sync_data.model_copy(update={"email": effective_email})

        # Check provider migration: different external_id, same email requires verified email
        user_service_check = UserService(db)
        existing_user = await user_service_check.get_by_email(effective_email)
        if existing_user and existing_user.external_id != sync_data.external_id:
            if oidc_claims.get("email_verified") is not True:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Email already associated with another account. Verified email required for migration.",
                )
    else:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No authentication method configured",
        )

    try:
        user, is_new = await user_service.sync_from_oidc(sync_data)
        await db.commit()
        await db.refresh(user)
    except UserEmailConflictError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        ) from None

    access_token = create_access_token(user.external_id, token_version=user.token_version)

    return UserSyncResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_new_user=is_new,
        onboarding_completed=user.onboarding_completed,
        access_token=access_token,
    )


@router.get("/session", response_model=UserResponse)
async def get_session(
    current_user: Annotated[User, Depends(get_current_user)],
) -> UserResponse:
    return UserResponse.model_validate(current_user)
