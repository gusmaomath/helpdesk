"""
Base de conhecimento (KB) — página dedicada.

Leitura é aberta a QUALQUER usuário autenticado (autoatendimento). Escrita
(criar/editar/excluir) é restrita a ADMINISTRADOR.

GET    /api/kb            -> busca/lista artigos (todos os usuários)
GET    /api/kb/{id}       -> artigo completo (todos)
POST   /api/kb            -> cria artigo avulso (admin)
PUT    /api/kb/{id}       -> edita (admin)
DELETE /api/kb/{id}       -> exclui (admin)
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.services import auditoria
from app.services import busca
from app.security.auth import exigir_admin, ip_requisicao, obter_usuario_atual
from app.database import get_db
from app.models import Artigo, Usuario
from app.schemas import ArtigoAtualizar, ArtigoCriar, ArtigoResposta

router = APIRouter(prefix="/api/kb", tags=["Base de conhecimento"])


@router.get("")
def listar(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
    busca_termo: Optional[str] = Query(None, alias="busca", max_length=150),
):
    """Busca por relevância (FTS5); sem termo, lista os mais recentes."""
    return busca.buscar_kb(db, busca_termo or "", limite=50)


@router.get("/{artigo_id}", response_model=ArtigoResposta)
def detalhar(
    artigo_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    artigo = db.get(Artigo, artigo_id)
    if artigo is None:
        raise HTTPException(404, "Artigo não encontrado.")
    return artigo


@router.post("", response_model=ArtigoResposta, status_code=201)
def criar(
    dados: ArtigoCriar,
    request: Request,
    db: Session = Depends(get_db),
    admin: Usuario = Depends(exigir_admin),
):
    artigo = Artigo(
        titulo=dados.titulo,
        conteudo=dados.conteudo,
        chamado_origem_id=dados.chamado_origem_id,
        criado_por_id=admin.id,
    )
    db.add(artigo)
    auditoria.registrar(
        db, usuario=admin, acao="artigo_criado", entidade="artigo",
        ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(artigo)
    return artigo


@router.put("/{artigo_id}", response_model=ArtigoResposta)
def atualizar(
    artigo_id: int,
    dados: ArtigoAtualizar,
    request: Request,
    db: Session = Depends(get_db),
    admin: Usuario = Depends(exigir_admin),
):
    artigo = db.get(Artigo, artigo_id)
    if artigo is None:
        raise HTTPException(404, "Artigo não encontrado.")
    if dados.titulo is not None:
        artigo.titulo = dados.titulo
    if dados.conteudo is not None:
        artigo.conteudo = dados.conteudo
    auditoria.registrar(
        db, usuario=admin, acao="artigo_editado", entidade="artigo",
        entidade_id=artigo.id, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(artigo)
    return artigo


@router.delete("/{artigo_id}", status_code=204)
def excluir(
    artigo_id: int,
    request: Request,
    db: Session = Depends(get_db),
    admin: Usuario = Depends(exigir_admin),
):
    artigo = db.get(Artigo, artigo_id)
    if artigo is None:
        raise HTTPException(404, "Artigo não encontrado.")
    db.delete(artigo)
    auditoria.registrar(
        db, usuario=admin, acao="artigo_excluido", entidade="artigo",
        entidade_id=artigo_id, ip=ip_requisicao(request),
    )
    db.commit()
