from pydantic import BaseModel, EmailStr, Field


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class VerifyResetTokenRequest(BaseModel):
    token: str


class ResetTokenInfo(BaseModel):
    email: EmailStr
    public_key: str | None
    encrypted_private_key_recovery: str | None
    recovery_key_salt: str | None


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)
    # All optional and independent of each other, same conditional-update pattern as
    # PublicKeyUpdate: present only when the client-side crypto for that piece actually
    # succeeded, so a failed/skipped recovery-code unwrap can't accidentally clobber
    # perfectly good existing key material with nulls.
    public_key: str | None = Field(default=None, max_length=2000)
    encrypted_private_key: str | None = Field(default=None, max_length=4000)
    key_salt: str | None = Field(default=None, max_length=64)
    encrypted_private_key_recovery: str | None = Field(default=None, max_length=4000)
    recovery_key_salt: str | None = Field(default=None, max_length=64)
