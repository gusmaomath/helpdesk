"""
Configuração do banco de dados (SQLAlchemy + SQLite).

Centraliza a criação da engine, da sessão e da Base declarativa.

Ajustes específicos para SQLite em uso concorrente (FastAPI):
- WAL (Write-Ahead Logging): leituras não bloqueiam escritas e vice-versa,
  reduzindo drasticamente os erros "database is locked".
- busy_timeout: em vez de falhar na hora, a conexão espera o lock liberar.
- foreign_keys=ON: o SQLite por padrão NÃO valida FKs; aqui ativamos.
"""
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import declarative_base, sessionmaker

from app.config import config

# check_same_thread=False é necessário para o SQLite funcionar com FastAPI,
# que pode acessar a conexão por threads diferentes.
engine = create_engine(
    config.DATABASE_URL,
    connect_args={"check_same_thread": False},
    echo=False,  # Em produção mantenha False para não logar SQL com dados sensíveis
)


@event.listens_for(Engine, "connect")
def _configurar_sqlite(dbapi_connection, connection_record):
    """
    Aplica PRAGMAs a cada nova conexão SQLite.

    Só atua em SQLite (verifica o tipo da conexão) — assim o código continua
    seguro caso um dia a DATABASE_URL aponte para outro banco.
    """
    # `sqlite3.Connection` tem o método `execute`; outros bancos não passam aqui.
    if config.DATABASE_URL.startswith("sqlite"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL;")
        cursor.execute("PRAGMA busy_timeout=5000;")   # 5s aguardando lock
        cursor.execute("PRAGMA foreign_keys=ON;")
        cursor.execute("PRAGMA synchronous=NORMAL;")  # bom equilíbrio com WAL
        cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """Dependência do FastAPI: fornece uma sessão e garante seu fechamento."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
