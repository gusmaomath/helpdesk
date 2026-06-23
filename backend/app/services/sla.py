"""
Cálculo de SLA em HORÁRIO COMERCIAL.

"4h de SLA" não significa 4h corridas — significa 4h de expediente. Um chamado
aberto sexta 17h não vence sábado de madrugada; o relógio só corre dentro da
jornada (config.SLA_HORA_INICIO..SLA_HORA_FIM) e em dias úteis.

Além disso, o tempo em "aguardando usuário" não conta (a responsabilidade está
com o solicitante). Esse desconto é feito via `sla_segundos_pausado` no chamado.

Implementação simples e sem dependências externas: avança minuto a minuto de
expediente. Suficiente e auditável para o volume de um helpdesk interno.
"""
from datetime import datetime, timedelta, timezone

from app.config import config


def _eh_expediente(dt: datetime, feriados: set | None = None) -> bool:
    if feriados and dt.strftime("%Y-%m-%d") in feriados:
        return False
    return (
        dt.weekday() in config.SLA_DIAS_UTEIS
        and config.SLA_HORA_INICIO <= dt.hour < config.SLA_HORA_FIM
    )


def _proximo_inicio_expediente(dt: datetime, feriados: set | None = None) -> datetime:
    """Avança `dt` até o próximo instante dentro do expediente."""
    guarda = 0
    while not _eh_expediente(dt, feriados) and guarda < 24 * 30:  # teto ~1 mês
        dt = (dt + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)
        guarda += 1
    return dt


def calcular_prazo(
    criado_em: datetime,
    prioridade: int | None,
    horas_por_prioridade: dict | None = None,
    feriados: set | None = None,
) -> datetime:
    """
    Soma N horas-úteis (conforme a prioridade) a partir de `criado_em`,
    respeitando jornada, dias úteis e feriados. `horas_por_prioridade` e
    `feriados` podem vir do banco (config editável); caso contrário usa os
    padrões de `config.py`. Retorna o deadline (timezone-aware UTC).
    """
    if criado_em.tzinfo is None:
        criado_em = criado_em.replace(tzinfo=timezone.utc)

    tabela = horas_por_prioridade or config.SLA_HORAS_POR_PRIORIDADE
    horas = tabela.get(prioridade or 1, 40)
    restante = timedelta(hours=horas)

    atual = _proximo_inicio_expediente(criado_em, feriados)
    passo = timedelta(minutes=15)  # granularidade do avanço

    guarda = 0
    while restante > timedelta(0) and guarda < 100_000:
        if _eh_expediente(atual, feriados):
            atual += passo
            restante -= passo
        else:
            atual = _proximo_inicio_expediente(atual, feriados)
        guarda += 1
    return atual


def carregar_parametros_sla(db):
    """
    Lê do banco a tabela de horas por prioridade e o conjunto de feriados.
    Retorna (dict_horas, set_feriados). Cai nos padrões se vazio.
    """
    from app.models import Feriado, ParametroSla
    horas = {p.prioridade: p.horas for p in db.query(ParametroSla).all()}
    if not horas:
        horas = dict(config.SLA_HORAS_POR_PRIORIDADE)
    feriados = {f.data for f in db.query(Feriado).all()}
    return horas, feriados


def segundos_uteis_decorridos(
    criado_em: datetime, agora: datetime, segundos_pausado: int
) -> int:
    """
    Segundos de expediente entre criação e agora, descontando as pausas
    (tempo em "aguardando usuário"). Usado para medir consumo real de SLA.
    """
    if criado_em.tzinfo is None:
        criado_em = criado_em.replace(tzinfo=timezone.utc)
    if agora.tzinfo is None:
        agora = agora.replace(tzinfo=timezone.utc)

    total = 0
    atual = criado_em
    passo = timedelta(minutes=5)
    guarda = 0
    while atual < agora and guarda < 200_000:
        if _eh_expediente(atual):
            total += int(passo.total_seconds())
        atual += passo
        guarda += 1
    return max(0, total - (segundos_pausado or 0))


def status_sla(prazo: datetime | None, agora: datetime | None = None) -> str:
    """
    Classifica a saúde do SLA para alertas em tempo real:
      - "vencido"   : já passou do prazo
      - "em_risco"  : faltam menos de 25% do tempo (proxy: < 2h)
      - "ok"        : dentro do prazo
      - "sem_sla"   : sem prazo definido
    """
    if prazo is None:
        return "sem_sla"
    agora = agora or datetime.now(timezone.utc)
    if prazo.tzinfo is None:
        prazo = prazo.replace(tzinfo=timezone.utc)
    if agora >= prazo:
        return "vencido"
    if (prazo - agora) <= timedelta(hours=2):
        return "em_risco"
    return "ok"


def faixa_aging(criado_em: datetime, agora: datetime | None = None) -> str:
    """Faixa de envelhecimento do chamado (para o relatório de aging)."""
    agora = agora or datetime.now(timezone.utc)
    if criado_em.tzinfo is None:
        criado_em = criado_em.replace(tzinfo=timezone.utc)
    horas = (agora - criado_em).total_seconds() / 3600.0
    if horas <= 4:
        return "0-4h"
    if horas <= 24:
        return "4-24h"
    if horas <= 72:
        return "1-3d"
    return ">3d"
