"""
Configurações centrais da aplicação.

Em ambiente bancário, segredos NUNCA devem ficar hardcoded.
Aqui usamos variáveis de ambiente com fallback apenas para desenvolvimento.
Em produção, defina SECRET_KEY via variável de ambiente / cofre de segredos.
"""
import os
import secrets
from pathlib import Path


def _env_int(nome: str, padrao: int) -> int:
    try:
        return int(os.getenv(nome, str(padrao)))
    except ValueError:
        return padrao


# Raiz do projeto (…/helpdesk), independente do diretório de execução.
# config.py está em  <raiz>/backend/app/config.py  → sobe 3 níveis.
RAIZ_PROJETO = Path(__file__).resolve().parents[2]
# Pasta única para todos os dados persistentes do projeto.
DB_DIR = RAIZ_PROJETO / "db"
DB_DIR.mkdir(parents=True, exist_ok=True)
(DB_DIR / "uploads").mkdir(parents=True, exist_ok=True)


class Config:
    # Chave para assinatura dos tokens JWT.
    # ATENÇÃO: em produção, defina via variável de ambiente. O fallback
    # gera uma chave aleatória a cada boot (invalida sessões em restart),
    # o que é proposital para forçar a configuração correta em produção.
    SECRET_KEY: str = os.getenv("HELPDESK_SECRET_KEY", secrets.token_hex(32))

    # Algoritmo de assinatura do JWT
    JWT_ALGORITHM: str = "HS256"

    # Tempo de expiração do token de acesso (em minutos)
    ACCESS_TOKEN_EXPIRE_MINUTES: int = _env_int("HELPDESK_TOKEN_EXPIRE_MINUTES", 480)

    # Caminho do banco SQLite — SEMPRE em <raiz>/db/helpdesk.db (caminho
    # absoluto), para não depender de onde o comando é executado.
    DATABASE_URL: str = os.getenv(
        "HELPDESK_DATABASE_URL",
        f"sqlite:///{(DB_DIR / 'helpdesk.db').as_posix()}",
    )

    # Política de senha
    MIN_PASSWORD_LENGTH: int = 8
    # Exige complexidade (maiúscula, minúscula, dígito e símbolo).
    SENHA_EXIGE_COMPLEXIDADE: bool = (
        os.getenv("HELPDESK_SENHA_COMPLEXIDADE", "1") == "1"
    )

    # --- Defesa contra brute force no login ---
    MAX_LOGIN_ATTEMPTS: int = _env_int("HELPDESK_MAX_LOGIN_ATTEMPTS", 5)
    # Janela (segundos) de bloqueio temporário após estourar as tentativas.
    LOGIN_BLOQUEIO_SEGUNDOS: int = _env_int("HELPDESK_LOGIN_BLOQUEIO_SEGUNDOS", 300)

    # --- Rate limit (aberturas de chamado por usuário) ---
    MAX_CHAMADOS_POR_MINUTO: int = _env_int("HELPDESK_MAX_CHAMADOS_MINUTO", 10)

    # Tamanho máximo permitido para campos de texto (anti-DoS / anti-abuso)
    MAX_TITULO_LENGTH: int = 150
    MAX_DESCRICAO_LENGTH: int = 5000
    MAX_RESPOSTA_LENGTH: int = 5000
    MAX_COMENTARIO_LENGTH: int = 5000

    # --- Uploads / evidências --- (junto do banco, em <raiz>/db/uploads)
    UPLOAD_DIR: str = os.getenv("HELPDESK_UPLOAD_DIR", str(DB_DIR / "uploads"))
    MAX_UPLOAD_BYTES: int = _env_int("HELPDESK_MAX_UPLOAD_BYTES", 10 * 1024 * 1024)  # 10MB
    EXTENSOES_PERMITIDAS = {
        ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".txt", ".log", ".csv",
        ".doc", ".docx", ".xls", ".xlsx", ".zip",
    }

    # --- SLA (horário comercial) ---
    # Jornada de atendimento (hora local, 0-23). Fora disso o relógio de SLA
    # não corre (sexta 17h não vence sábado de madrugada).
    SLA_HORA_INICIO: int = _env_int("HELPDESK_SLA_HORA_INICIO", 8)
    SLA_HORA_FIM: int = _env_int("HELPDESK_SLA_HORA_FIM", 18)
    # Dias úteis: 0=segunda ... 6=domingo.
    SLA_DIAS_UTEIS = {0, 1, 2, 3, 4}
    # Horas-úteis de SLA por prioridade (5 = mais urgente).
    SLA_HORAS_POR_PRIORIDADE = {5: 2, 4: 4, 3: 8, 2: 24, 1: 40}


config = Config()
