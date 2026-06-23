"""
Notificações in-app (o "sininho").

GET    /api/notificacoes            -> lista as minhas (não lidas primeiro)
GET    /api/notificacoes/contagem   -> nº de não lidas (badge do sino)
PUT    /api/notificacoes/{id}/lida  -> marca uma como lida
PUT    /api/notificacoes/lidas      -> marca todas como lidas
DELETE /api/notificacoes/{id}       -> apaga uma
DELETE /api/notificacoes            -> apaga todas as minhas
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Notificacao, Usuario
from app.schemas import NotificacaoResposta
from app.security.auth import obter_usuario_atual

router = APIRouter(prefix="/api/notificacoes", tags=["Notificações"])


@router.get("", response_model=list[NotificacaoResposta])
def listar(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
    limite: int = 50,
):
    return (
        db.query(Notificacao)
        .filter(Notificacao.usuario_id == usuario.id)
        .order_by(Notificacao.lida.asc(), Notificacao.criado_em.desc())
        .limit(min(limite, 100))
        .all()
    )


@router.get("/contagem")
def contagem(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    n = (
        db.query(Notificacao)
        .filter(Notificacao.usuario_id == usuario.id, Notificacao.lida.is_(False))
        .count()
    )
    return {"nao_lidas": n}


@router.put("/lidas")
def marcar_todas(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    db.execute(
        update(Notificacao)
        .where(Notificacao.usuario_id == usuario.id, Notificacao.lida.is_(False))
        .values(lida=True)
    )
    db.commit()
    return {"detail": "ok"}


@router.put("/{notif_id}/lida")
def marcar_lida(
    notif_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    n = db.get(Notificacao, notif_id)
    if n is None or n.usuario_id != usuario.id:
        raise HTTPException(404, "Notificação não encontrada.")
    n.lida = True
    db.commit()
    return {"detail": "ok"}


@router.delete("/{notif_id}", status_code=204)
def apagar(
    notif_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    n = db.get(Notificacao, notif_id)
    if n is None or n.usuario_id != usuario.id:
        raise HTTPException(404, "Notificação não encontrada.")
    db.delete(n)
    db.commit()


@router.delete("", status_code=204)
def apagar_todas(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    db.execute(delete(Notificacao).where(Notificacao.usuario_id == usuario.id))
    db.commit()
