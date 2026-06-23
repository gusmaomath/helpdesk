"""
Aplicação principal do Helpdesk.

Responsabilidades:
- Monta a aplicação FastAPI e registra os routers de API.
- Cria as tabelas no banco (na inicialização).
- Serve os arquivos estáticos do front-end (HTML/CSS/JS).
- Aplica cabeçalhos de segurança e tratamento global de erros.

Como rodar:
    cd backend
    pip install -r requirements.txt
    python seed.py        # cria usuários de exemplo
    uvicorn main:app --host 0.0.0.0 --port 8000

Acesse:  http://localhost:8000
"""
import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.database import Base, engine
from app import models  # noqa: F401  (garante o registro dos modelos antes do create_all)
from app.routers.admin import router as router_admin
from app.routers.auth import router as router_auth
from app.routers.chamados import router as router_chamados
from app.routers.kb import router as router_kb
from app.routers.notificacoes import router as router_notificacoes
from app.routers.usuarios import router as router_usuarios

# Logging estruturado básico (em produção, troque por handler JSON).
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
logger = logging.getLogger("helpdesk")

# Cria as tabelas se ainda não existirem.
# NOTA: create_all NÃO altera tabelas já existentes. Ao evoluir o schema em
# desenvolvimento, recrie o banco com `python seed.py --reset` (ver seed.py).
# Em produção, gerencie o schema com Alembic (ver README/observações).
Base.metadata.create_all(bind=engine)

# Índices de busca textual (FTS5) — tabelas virtuais + gatilhos de sincronia.
from app.services import busca  # noqa: E402
busca.garantir_fts(engine)

app = FastAPI(
    title="Helpdesk Corporativo",
    description="Sistema interno de abertura e gestão de chamados.",
    version="1.0.0",
)

# Caminho absoluto para a pasta do front-end
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
STATIC_DIR = os.path.join(FRONTEND_DIR, "static")
TEMPLATES_DIR = os.path.join(FRONTEND_DIR, "templates")


# --------------------------------------------------------------------------- #
# Middleware de cabeçalhos de segurança (defesa em profundidade)
# --------------------------------------------------------------------------- #
@app.middleware("http")
async def cabecalhos_seguranca(request: Request, call_next):
    response = await call_next(request)
    # Impede que o navegador "adivinhe" tipos de conteúdo
    response.headers["X-Content-Type-Options"] = "nosniff"
    # Impede que a página seja embutida em iframes (anti-clickjacking)
    response.headers["X-Frame-Options"] = "DENY"
    # Política de referência mínima
    response.headers["Referrer-Policy"] = "no-referrer"
    # CSP restritiva: scripts/estilos só do próprio domínio.
    # 'unsafe-inline' em style é tolerado para simplificar; em produção
    # rigorosa, mova estilos inline para arquivos .css e remova-o.
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'"
    )
    return response


# --------------------------------------------------------------------------- #
# Tratamento global de exceções não previstas
# --------------------------------------------------------------------------- #
@app.exception_handler(Exception)
async def handler_erro_global(request: Request, exc: Exception):
    # Em produção NÃO expomos o stacktrace ao cliente (vazaria detalhes
    # internos). Logamos no servidor e devolvemos mensagem genérica.
    # (Aqui um print simples; em produção use logging estruturado.)
    logger.exception("Erro não tratado em %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Ocorreu um erro interno. Tente novamente."},
    )


# --------------------------------------------------------------------------- #
# Registro dos routers de API
# --------------------------------------------------------------------------- #
app.include_router(router_auth)
app.include_router(router_chamados)
app.include_router(router_admin)
app.include_router(router_usuarios)
app.include_router(router_kb)
app.include_router(router_notificacoes)


# --------------------------------------------------------------------------- #
# Servir arquivos estáticos e páginas HTML
# --------------------------------------------------------------------------- #
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def pagina_inicial():
    return FileResponse(os.path.join(TEMPLATES_DIR, "index.html"))


@app.get("/app")
def pagina_app():
    return FileResponse(os.path.join(TEMPLATES_DIR, "app.html"))


@app.get("/health")
def health_check():
    """Endpoint simples para monitoramento de disponibilidade."""
    return {"status": "ok"}
