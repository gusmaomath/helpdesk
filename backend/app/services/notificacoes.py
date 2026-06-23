"""
Notificações.

Duas camadas:
1. **In-app (persistente)** — `notificar_usuario()` cria uma linha em
   `notificacoes` para um usuário específico. É o que alimenta o "sininho" do
   topo (listar, marcar como lida, apagar).
2. **Transporte externo plugável** — `CanalLog` (padrão) só registra em log;
   amanhã troca-se por e-mail/Teams/Slack sem mexer no resto (mesmo padrão da IA).

Nada disso derruba o fluxo principal: falhas são capturadas e só logadas.
"""
import logging
from abc import ABC, abstractmethod
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Notificacao

logger = logging.getLogger("helpdesk.notificacoes")


class CanalNotificacao(ABC):
    @abstractmethod
    def enviar(self, destino: str, assunto: str, corpo: str) -> None:
        ...


class CanalLog(CanalNotificacao):
    """Canal padrão de desenvolvimento: registra em log, não envia nada."""

    def enviar(self, destino: str, assunto: str, corpo: str) -> None:
        logger.info("NOTIFICAÇÃO -> %s | %s | %s", destino, assunto, corpo)


# Para o futuro (NÃO ativo): CanalTeams faria POST num Incoming Webhook.
canal_ativo: CanalNotificacao = CanalLog()


def notificar(destino: str, assunto: str, corpo: str) -> None:
    """Transporte externo (log hoje). Nunca derruba o fluxo principal."""
    try:
        canal_ativo.enviar(destino, assunto, corpo)
    except Exception as exc:  # pragma: no cover - resiliência
        logger.warning("Falha ao notificar %s: %s", destino, exc)


def notificar_usuario(
    db: Session,
    usuario_id: Optional[int],
    titulo: str,
    corpo: str = "",
    entidade: Optional[str] = None,
    entidade_id: Optional[int] = None,
    commit: bool = False,
) -> None:
    """
    Cria uma notificação in-app para `usuario_id` (o "sininho" mostra). Não faz
    commit por padrão — participa da transação da ação que a gerou.
    """
    if not usuario_id:
        return
    try:
        db.add(Notificacao(
            usuario_id=usuario_id, titulo=titulo, corpo=corpo,
            entidade=entidade, entidade_id=entidade_id,
        ))
        if commit:
            db.commit()
    except Exception as exc:  # pragma: no cover
        logger.warning("Falha ao gravar notificação p/ %s: %s", usuario_id, exc)
