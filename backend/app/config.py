from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "sqlite+aiosqlite:///./hybridchat.db"
    REDIS_URL: str = "fake"  # "fake" runs an in-process fakeredis broker for zero-infra local dev
    JWT_SECRET: str = "dev-secret-change-me"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440
    CLIENT_URL: str = "http://localhost:5173"
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_MB: int = 15
    # Password-reset emails go out over Gmail's own SMTP relay rather than a transactional-email
    # provider — see app/utils/email.py for why (both Resend and Mailgun's free tiers turned out
    # to require either a verified domain or a pre-authorized recipient list to deliver anywhere
    # real). GMAIL_APP_PASSWORD is a 16-character app password generated from the Google
    # Account's Security settings (requires 2-Step Verification enabled) — never the account's
    # real login password. If unset, app/utils/email.py logs the reset link instead of emailing
    # it, so this feature works locally with zero third-party setup, same as REDIS_URL=fake.
    GMAIL_ADDRESS: str | None = None
    GMAIL_APP_PASSWORD: str | None = None

    @field_validator("DATABASE_URL")
    @classmethod
    def _use_asyncpg_driver(cls, v: str) -> str:
        # Hosted Postgres providers (Railway, Neon, Render, ...) hand out a plain
        # postgres:// or postgresql:// URL — SQLAlchemy's async engine needs the
        # +asyncpg driver suffix, so normalize it instead of making every deploy
        # hand-edit the URL their host gave them.
        if v.startswith("postgres://"):
            v = "postgresql+asyncpg://" + v[len("postgres://"):]
        elif v.startswith("postgresql://"):
            v = "postgresql+asyncpg://" + v[len("postgresql://"):]

        if v.startswith("postgresql+asyncpg://"):
            # `sslmode` is a psycopg2/libpq query param that hosted providers (Neon,
            # Supabase, ...) append by default. asyncpg's connect() has no such kwarg
            # and raises a TypeError if it's passed through — but asyncpg negotiates
            # TLS automatically with servers that require it anyway, so just drop it.
            parts = urlsplit(v)
            query = [(k, val) for k, val in parse_qsl(parts.query) if k.lower() != "sslmode"]
            v = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))

        return v


settings = Settings()
