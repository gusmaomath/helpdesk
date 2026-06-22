"""
Camada de notificações — PLUG AND PLAY (mesmo padrão do módulo de IA).

Hoje o canal ativo apenas registra a notificação em log (e numa tabela de
auditoria, opcionalmente). Amanhã, para enviar por e-mail/Teams/Slack, basta:

    1. Criar uma classe que herde de `CanalNotificacao`.
    2. Implementar `enviar(destino, assunto, corpo)`.
    3. Trocar `canal_ativo` no final do arquivo (ou compor vários).

Assim o resto do sistema chama sempre `notificar(...)` e não sabe (nem precisa
saber) qual transporte está por trás. Para Teams/Slack, o `enviar` faria um
POST no Incoming Webhook configurado por variável de ambiente.
"""
import logging
from abc import ABC, abstractmethod

logger = logging.getLogger("helpdesk.notificacoes")


class CanalNotificacao(ABC):
    @abstractmethod
    def enviar(self, destino: str, assunto: str, corpo: str) -> None:
        ...


class CanalLog(CanalNotificacao):
    """Canal padrão de desenvolvimento: registra em log, não envia nada."""

    def enviar(self, destino: str, assunto: str, corpo: str) -> None:
        logger.info("NOTIFICAÇÃO -> %s | %s | %s", destino, assunto, corpo)


# Exemplo de esqueleto para o futuro (NÃO ativo):
#
# import os, json, urllib.request
# class CanalTeams(CanalNotificacao):
#     def __init__(self):
#         self.webhook = os.getenv("HELPDESK_TEAMS_WEBHOOK", "")
#     def enviar(self, destino, assunto, corpo):
#         if not self.webhook:
#             return
#         payload = json.dumps({"text": f"**{assunto}**\n{corpo}"}).encode()
#         req = urllib.request.Request(
#             self.webhook, data=payload,
#             headers={"Content-Type": "application/json"},
#         )
#         urllib.request.urlopen(req, timeout=5)


canal_ativo: CanalNotificacao = CanalLog()


def notificar(destino: str, assunto: str, corpo: str) -> None:
    """
    Ponto público. Nunca derruba o fluxo principal por falha de notificação
    (degradação graciosa): captura exceções e só registra.
    """
    try:
        canal_ativo.enviar(destino, assunto, corpo)
    except Exception as exc:  # pragma: no cover - resiliência
        logger.warning("Falha ao notificar %s: %s", destino, exc)
