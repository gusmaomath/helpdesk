"""
Rotas de autenticação.

POST /api/auth/login   -> autentica e devolve JWT (com bloqueio anti-brute-force)
GET  /api/auth/me      -> retorna dados do usuário logado
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

import auditoria
from auth import (
    controle_tentativas,
    criar_token_acesso,
    gerar_hash_senha,
    ip_requisicao,
    obter_usuario_atual,
    verificar_senha,
)
from database import get_db
from models import NivelAcesso, Papel, Usuario
from schemas import AutoCadastro, LoginRequest, TokenResponse, UsuarioResposta

router = APIRouter(prefix="/api/auth", tags=["Autenticação"])


@router.post("/login", response_model=TokenResponse)
def login(dados: LoginRequest, request: Request, db: Session = Depends(get_db)):
    chave = dados.matricula.lower()

    # 1) Bloqueio temporário por excesso de tentativas (defesa brute force).
    if controle_tentativas.bloqueado(chave):
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
        controle_tentativas.registrar_falha(chave)
        # Auditoria de falha de login (sem revelar qual usuário).
        auditoria.registrar(
            db, usuario=None, acao="login_falha", entidade="usuario",
            detalhe={"matricula": dados.matricula}, ip=ip_requisicao(request),
            commit=True,
        )
        raise erro_generico

    controle_tentativas.limpar(chave)
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
    )


@router.post("/registrar", status_code=status.HTTP_201_CREATED)
def registrar(dados: AutoCadastro, request: Request, db: Session = Depends(get_db)):
    """
    Auto-cadastro público. O usuário é criado SEMPRE como colaborador e
    INATIVO (ativo=0): só passa a acessar após um administrador APROVAR na
    tela de gestão de usuários. Isso evita criação livre de contas com acesso.
    """
    if db.query(Usuario).filter(Usuario.matricula == dados.matricula).first():
        raise HTTPException(status_code=409, detail="Matrícula já cadastrada.")

    novo = Usuario(
        nome=dados.nome,
        matricula=dados.matricula,
        senha_hash=gerar_hash_senha(dados.senha),
        nivel_acesso=NivelAcesso.USUARIO,
        papel=Papel.COLABORADOR,
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


@router.get("/me", response_model=UsuarioResposta)
def quem_sou_eu(usuario: Usuario = Depends(obter_usuario_atual)):
    return usuario
