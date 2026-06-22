"""
Máquina de estados do chamado.

Sem isto, qualquer status poderia virar qualquer status. Aqui declaramos
EXPLICITAMENTE quais transições são permitidas e validamos no backend.

Regra de ouro: um chamado FECHADO só pode ser REABERTO (não volta direto
para "em andamento"); um RESOLVIDO pode ser fechado, reaberto, etc.
"""
from models import StatusChamado

# De cada status, para quais ele pode ir.
TRANSICOES_PERMITIDAS: dict[StatusChamado, set[StatusChamado]] = {
    StatusChamado.ABERTO: {
        StatusChamado.EM_ANDAMENTO,
        StatusChamado.AGUARDANDO_USUARIO,
        StatusChamado.RESOLVIDO,
        StatusChamado.CANCELADO,
    },
    StatusChamado.EM_ANDAMENTO: {
        StatusChamado.AGUARDANDO_USUARIO,
        StatusChamado.RESOLVIDO,
        StatusChamado.CANCELADO,
    },
    StatusChamado.AGUARDANDO_USUARIO: {
        StatusChamado.EM_ANDAMENTO,
        StatusChamado.RESOLVIDO,
        StatusChamado.CANCELADO,
    },
    StatusChamado.RESOLVIDO: {
        StatusChamado.FECHADO,
        StatusChamado.REABERTO,
    },
    StatusChamado.FECHADO: {
        StatusChamado.REABERTO,
    },
    StatusChamado.REABERTO: {
        StatusChamado.EM_ANDAMENTO,
        StatusChamado.AGUARDANDO_USUARIO,
        StatusChamado.RESOLVIDO,
        StatusChamado.CANCELADO,
    },
    StatusChamado.CANCELADO: {
        StatusChamado.REABERTO,
    },
}

# Estados em que o relógio de SLA fica PAUSADO (a bola está com o cliente).
ESTADOS_PAUSA_SLA = {StatusChamado.AGUARDANDO_USUARIO}

# Estados que consideramos "encerrados" (param o SLA definitivamente).
ESTADOS_ENCERRADOS = {
    StatusChamado.RESOLVIDO,
    StatusChamado.FECHADO,
    StatusChamado.CANCELADO,
}


def transicao_valida(atual: StatusChamado, novo: StatusChamado) -> bool:
    """True se a mudança de `atual` para `novo` é permitida (ou se é o mesmo)."""
    if atual == novo:
        return True
    return novo in TRANSICOES_PERMITIDAS.get(atual, set())


def proximos_status(atual: StatusChamado) -> list[StatusChamado]:
    """Lista os destinos válidos a partir do status atual (para popular UI)."""
    return sorted(
        TRANSICOES_PERMITIDAS.get(atual, set()),
        key=lambda s: s.value,
    )
