"""
Autenticação e autorização.

- Hash de senha com bcrypt (via passlib) — nunca armazenamos senha em claro.
- Emissão e verificação de tokens JWT, com `tv` (token_version) para revogação
  imediata: trocar o papel / desativar / forçar logout incrementa a versão e
  invalida todos os tokens antigos do usuário.
- Dependências do FastAPI para proteger rotas, exigir papel e calcular o
  ESCOPO de visão hierárquico (quem vê os chamados de quem).
- Controle de tentativas de login (brute force) em memória de processo.

Decisões de segurança para ambiente bancário:
- Tokens com expiração curta (turno de trabalho).
- Mensagens de erro genéricas no login (dificulta enumeração de usuários).
"""
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from config import config
from database import get_db
from models import NivelAcesso, Papel, Usuario

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login")


def gerar_hash_senha(senha: str) -> str:
    return pwd_context.hash(senha)


def verificar_senha(senha_plana: str, senha_hash: str) -> bool:
    return pwd_context.verify(senha_plana, senha_hash)


def criar_token_acesso(usuario: Usuario) -> str:
    """Cria um JWT assinado com expiração, carregando id, papel e token_version."""
    expira = datetime.now(timezone.utc) + timedelta(
        minutes=config.ACCESS_TOKEN_EXPIRE_MINUTES
    )
    payload = {
        "sub": str(usuario.id),
        "papel": usuario.papel.value,
        "tv": usuario.token_version,
        "exp": expira,
    }
    return jwt.encode(payload, config.SECRET_KEY, algorithm=config.JWT_ALGORITHM)


# --------------------------------------------------------------------------- #
# Política de senha
# --------------------------------------------------------------------------- #
def validar_senha_forte(senha: str) -> Optional[str]:
    """
    Retorna uma mensagem de erro se a senha não cumpre a política, ou None se OK.
    Centraliza a regra para ser reutilizada pelos schemas e pela troca de senha.
    """
    if len(senha) < config.MIN_PASSWORD_LENGTH:
        return f"A senha deve ter ao menos {config.MIN_PASSWORD_LENGTH} caracteres."
    if config.SENHA_EXIGE_COMPLEXIDADE:
        if not re.search(r"[a-z]", senha):
            return "A senha deve conter ao menos uma letra minúscula."
        if not re.search(r"[A-Z]", senha):
            return "A senha deve conter ao menos uma letra maiúscula."
        if not re.search(r"\d", senha):
            return "A senha deve conter ao menos um número."
        if not re.search(r"[^A-Za-z0-9]", senha):
            return "A senha deve conter ao menos um caractere especial."
    return None


# --------------------------------------------------------------------------- #
# Dependências
# --------------------------------------------------------------------------- #
def obter_usuario_atual(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> Usuario:
    """Valida o token (assinatura, expiração, token_version) e retorna o usuário."""
    excecao = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Credenciais inválidas ou sessão expirada.",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, config.SECRET_KEY, algorithms=[config.JWT_ALGORITHM])
        usuario_id: Optional[str] = payload.get("sub")
        tv = payload.get("tv", 0)
        if usuario_id is None:
            raise excecao
    except JWTError:
        raise excecao

    usuario = db.query(Usuario).filter(Usuario.id == int(usuario_id)).first()
    if usuario is None or usuario.ativo != 1:
        raise excecao
    # Revogação: se a versão do token não bate, foi invalidado (papel mudou etc.)
    if tv != usuario.token_version:
        raise excecao
    return usuario


def exigir_admin(usuario: Usuario = Depends(obter_usuario_atual)) -> Usuario:
    if usuario.nivel_acesso != NivelAcesso.ADMINISTRADOR:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Acesso restrito a administradores.",
        )
    return usuario


def exigir_papel_minimo(mínimo: Papel):
    """Fábrica de dependência: exige papel com rank >= o mínimo informado."""
    def _dep(usuario: Usuario = Depends(obter_usuario_atual)) -> Usuario:
        if usuario.papel.rank < mínimo.rank:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Permissão insuficiente para esta ação.",
            )
        return usuario
    return _dep


# --------------------------------------------------------------------------- #
# Escopo de visão hierárquico
# --------------------------------------------------------------------------- #
def ids_subordinados_diretos(db: Session, usuario: Usuario) -> set[int]:
    """IDs de quem está DIRETAMENTE abaixo de `usuario` (um nível)."""
    rows = db.query(Usuario.id).filter(Usuario.supervisor_id == usuario.id).all()
    return {r[0] for r in rows}


def ids_descendentes(db: Session, usuario: Usuario) -> set[int]:
    """
    IDs de TODA a cadeia abaixo de `usuario` (subordinados diretos + indiretos),
    percorrendo a árvore. NÃO inclui o próprio. Protegido contra ciclos.
    """
    descendentes: set[int] = set()
    fila = [usuario.id]
    while fila:
        atual = fila.pop()
        filhos = db.query(Usuario.id).filter(Usuario.supervisor_id == atual).all()
        for (fid,) in filhos:
            if fid not in descendentes and fid != usuario.id:
                descendentes.add(fid)
                fila.append(fid)
    return descendentes


def ids_visiveis_para(db: Session, usuario: Usuario) -> set[int]:
    """
    Escopo de visão/controle de um usuário comum: ele mesmo + TODA a cadeia
    abaixo dele. Se `autor_id` de um chamado está neste conjunto, o usuário é
    o dono OU um superior (ancestral) do dono — base para ver e cancelar.
    Administradores veem tudo (este helper não se aplica a eles).
    """
    return {usuario.id} | ids_descendentes(db, usuario)


def ip_requisicao(request: Request) -> str:
    """IP de origem (considera proxy reverso via X-Forwarded-For)."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "desconhecido"
