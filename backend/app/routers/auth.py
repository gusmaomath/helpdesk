"""
Rotas de autenticação.

POST /api/auth/login         -> autentica e devolve JWT (anti-brute-force em tabela)
POST /api/auth/registrar     -> auto-cadastro (conta pendente de aprovação)
POST /api/auth/trocar-senha  -> troca de senha (obrigatória se provisória)
GET  /api/auth/me            -> dados do usuário logado
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.services import auditoria
from app.security import rate_limit
from app.security.auth import (
    criar_token_acesso,
    gerar_hash_senha,
    ip_requisicao,
    obter_usuario_atual,
    validar_senha_forte,
    verificar_senha,
)
from app.config import config
from app.database import get_db
from app.models import NivelAcesso, Papel, Usuario
from app.schemas import (
    AutoCadastro,
    LoginRequest,
    PerfilAtualizar,
    TokenResponse,
    TrocarSenha,
    UsuarioResposta,
)

router = APIRouter(prefix="/api/auth", tags=["Autenticação"])

TIPO_LOGIN = "login_falha"


@router.post("/login", response_model=TokenResponse)
def login(dados: LoginRequest, request: Request, db: Session = Depends(get_db)):
    chave = dados.matricula.lower()

    # 1) Bloqueio temporário por excesso de tentativas (persistente, em tabela).
    if rate_limit.excedeu(
        db, TIPO_LOGIN, chave,
        config.MAX_LOGIN_ATTEMPTS, config.LOGIN_BLOQUEIO_SEGUNDOS,
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Muitas tentativas. Tente novamente em alguns minutos.",
        )

    usuario = db.query(Usuario).filter(Usuario.matricula == dados.matricula).first()

    erro_generico = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Matrícula ou senha incorretos.",
    )

    if (
        usuario is None
        or usuario.ativo != 1
        or not verificar_senha(dados.senha, usuario.senha_hash)
    ):
        rate_limit.registrar(db, TIPO_LOGIN, chave)
        auditoria.registrar(
            db, usuario=None, acao="login_falha", entidade="usuario",
            detalhe={"matricula": dados.matricula}, ip=ip_requisicao(request),
            commit=True,
        )
        raise erro_generico

    rate_limit.limpar(db, TIPO_LOGIN, chave)
    token = criar_token_acesso(usuario)
    auditoria.registrar(
        db, usuario=usuario, acao="login_sucesso", entidade="usuario",
        entidade_id=usuario.id, ip=ip_requisicao(request), commit=True,
    )

    return TokenResponse(
        access_token=token,
        id=usuario.id,
        nome=usuario.nome,
        nivel_acesso=usuario.nivel_acesso,
        papel=usuario.papel,
        organizacao=usuario.organizacao,
        senha_provisoria=bool(usuario.senha_provisoria),
    )


@router.post("/registrar", status_code=status.HTTP_201_CREATED)
def registrar(dados: AutoCadastro, request: Request, db: Session = Depends(get_db)):
    """
    Auto-cadastro público. O usuário é criado SEMPRE como colaborador e
    INATIVO (ativo=0): só acessa após um administrador aprovar.
    """
    if db.query(Usuario).filter(Usuario.matricula == dados.matricula).first():
        raise HTTPException(status_code=409, detail="Matrícula já cadastrada.")

    novo = Usuario(
        nome=dados.nome,
        matricula=dados.matricula,
        senha_hash=gerar_hash_senha(dados.senha),
        nivel_acesso=NivelAcesso.USUARIO,
        papel=Papel.COLABORADOR,
        organizacao=dados.organizacao,
        email=dados.email,
        unidade_setor=dados.unidade_setor,
        ativo=0,  # PENDENTE de aprovação
    )
    db.add(novo)
    db.flush()
    auditoria.registrar(
        db, usuario=None, acao="autocadastro_solicitado", entidade="usuario",
        entidade_id=novo.id, detalhe={"matricula": novo.matricula},
        ip=ip_requisicao(request),
    )
    db.commit()
    return {
        "detail": "Cadastro recebido! Aguarde a aprovação de um administrador "
                  "para acessar o sistema.",
    }


@router.post("/trocar-senha")
def trocar_senha(
    dados: TrocarSenha,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Troca a própria senha. Obrigatória quando `senha_provisoria` é True
    (primeiro acesso de contas criadas pelo admin).
    """
    if not verificar_senha(dados.senha_atual, usuario.senha_hash):
        raise HTTPException(status_code=401, detail="Senha atual incorreta.")
    if verificar_senha(dados.nova_senha, usuario.senha_hash):
        raise HTTPException(status_code=422, detail="A nova senha deve ser diferente da atual.")

    usuario.senha_hash = gerar_hash_senha(dados.nova_senha)
    usuario.senha_provisoria = False
    auditoria.registrar(
        db, usuario=usuario, acao="senha_trocada", entidade="usuario",
        entidade_id=usuario.id, ip=ip_requisicao(request),
    )
    db.commit()
    return {"detail": "Senha atualizada com sucesso."}


@router.put("/perfil", response_model=UsuarioResposta)
def atualizar_perfil(
    dados: PerfilAtualizar,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """Atualiza os próprios dados de contato (e-mail e ramal)."""
    if dados.email is not None:
        usuario.email = dados.email
    if dados.ramal is not None:
        usuario.ramal = dados.ramal
    db.commit()
    db.refresh(usuario)
    return usuario


@router.get("/me", response_model=UsuarioResposta)
def quem_sou_eu(usuario: Usuario = Depends(obter_usuario_atual)):
    return usuario
