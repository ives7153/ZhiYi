from typing import Literal
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

from app.schemas.user import UserResponse


class TokenPayload(BaseModel):
    sub: str  # Subject (external_id from OIDC or local)
    exp: int  # Expiration timestamp
    iat: int | None = None  # Issued at timestamp
    email: str | None = None
    name: str | None = None
    ver: int = 1  # Token version for revocation check


class AuthSession(BaseModel):
    user_id: UUID
    external_id: str
    email: str
    display_name: str
    family_id: UUID | None = None
    role: str
    is_authenticated: bool = True


class SendCodeRequest(BaseModel):
    email: EmailStr
    purpose: Literal["register", "reset_password"]


class SendCodeResponse(BaseModel):
    success: bool
    message: str
    delivery_mode: str = "smtp"  # "smtp" or "test_mailbox"


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    code: str = Field(..., min_length=4, max_length=10)
    display_name: str | None = Field(None, max_length=100)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=128)


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str = Field(..., min_length=4, max_length=10)
    new_password: str = Field(..., min_length=8, max_length=128)


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=8, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
