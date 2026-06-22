"""
Helpers de trilha de auditoria.

`registrar()` grava um evento imutável de "quem fez o quê, quando e de onde".
Guardamos um snapshot do nome do usuário para que o histórico continue legível
mesmo que o usuário seja renomeado ou desativado depois.
"""
import json
from typing import Optional

from sqlalchemy.orm import Session

from models import Auditoria, Usuario


def registrar(
    db: Session,
    *,
    usuario: Optional[Usuario],
    acao: str,
    entidade: Optional[str] = None,
    entidade_id: Optional[int] = None,
    detalhe: Optional[dict] = None,
    ip: Optional[str] = None,
    commit: bool = False,
) -> Auditoria:
    """
    Cria um registro de auditoria. Por padrão NÃO faz commit — deixa o evento
    participar da mesma transação da ação auditada (tudo ou nada).
    """
    evento = Auditoria(
        usuario_id=usuario.id if usuario else None,
        usuario_nome=usuario.nome if usuario else "sistema",
        acao=acao,
        entidade=entidade,
        entidade_id=entidade_id,
        detalhe=json.dumps(detalhe, ensure_ascii=False) if detalhe else None,
        ip=ip,
    )
    db.add(evento)
    if commit:
        db.commit()
    return evento
