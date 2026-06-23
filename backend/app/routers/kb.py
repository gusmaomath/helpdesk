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

from sqlalchemy import func

from app.services import auditoria
from app.services import busca
from app.security.auth import exigir_admin, ip_requisicao, obter_usuario_atual
from app.database import get_db
from app.models import Artigo, ArtigoVoto, Usuario
from app.schemas import (
    ArtigoAtualizar,
    ArtigoCriar,
    ArtigoResposta,
    ArtigoVotoRequest,
)

router = APIRouter(prefix="/api/kb", tags=["Base de conhecimento"])


def _votos(db: Session, ids: list[int], usuario_id: int):
    """Retorna {id: (uteis, nao_uteis)} e {id: meu_voto} para os artigos dados."""
    if not ids:
        return {}, {}
    contagem = {}
    for aid, util, qtd in (
        db.query(ArtigoVoto.artigo_id, ArtigoVoto.util, func.count(ArtigoVoto.id))
        .filter(ArtigoVoto.artigo_id.in_(ids))
        .group_by(ArtigoVoto.artigo_id, ArtigoVoto.util).all()
    ):
        u, n = contagem.get(aid, (0, 0))
        contagem[aid] = (u + qtd, n) if util else (u, n + qtd)
    meus = {
        v.artigo_id: v.util
        for v in db.query(ArtigoVoto).filter(
            ArtigoVoto.artigo_id.in_(ids), ArtigoVoto.usuario_id == usuario_id
        ).all()
    }
    return contagem, meus


def _resposta(artigo: Artigo, contagem, meus) -> ArtigoResposta:
    u, n = contagem.get(artigo.id, (0, 0))
    r = ArtigoResposta.model_validate(artigo)
    r.uteis, r.nao_uteis = u, n
    r.meu_voto = meus.get(artigo.id)
    return r


@router.get("", response_model=list[ArtigoResposta])
def listar(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
    busca_termo: Optional[str] = Query(None, alias="busca", max_length=150),
):
    """Busca por relevância (FTS5); sem termo, lista os mais recentes."""
    achados = busca.buscar_kb(db, busca_termo or "", limite=50)
    ids = [a["id"] for a in achados]
    artigos = {a.id: a for a in db.query(Artigo).filter(Artigo.id.in_(ids)).all()}
    contagem, meus = _votos(db, ids, usuario.id)
    # Preserva a ordem de relevância do FTS.
    return [_resposta(artigos[i], contagem, meus) for i in ids if i in artigos]


@router.get("/{artigo_id}", response_model=ArtigoResposta)
def detalhar(
    artigo_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    artigo = db.get(Artigo, artigo_id)
    if artigo is None:
        raise HTTPException(404, "Artigo não encontrado.")
    contagem, meus = _votos(db, [artigo_id], usuario.id)
    return _resposta(artigo, contagem, meus)


@router.post("/{artigo_id}/voto", response_model=ArtigoResposta)
def votar(
    artigo_id: int,
    dados: ArtigoVotoRequest,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """Registra/atualiza o voto 'isso resolveu?' (👍/👎) — 1 por usuário."""
    artigo = db.get(Artigo, artigo_id)
    if artigo is None:
        raise HTTPException(404, "Artigo não encontrado.")
    voto = (
        db.query(ArtigoVoto)
        .filter(ArtigoVoto.artigo_id == artigo_id, ArtigoVoto.usuario_id == usuario.id)
        .first()
    )
    if voto is None:
        db.add(ArtigoVoto(artigo_id=artigo_id, usuario_id=usuario.id, util=dados.util))
    else:
        voto.util = dados.util
    db.commit()
    contagem, meus = _votos(db, [artigo_id], usuario.id)
    return _resposta(artigo, contagem, meus)


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
