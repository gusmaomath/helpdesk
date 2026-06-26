"""
Feriados da B3 (Bolsa brasileira).

Duas fontes, na ordem de preferência:
  1. `pandas_market_calendars` (pega o calendário oficial da B3 sem digitar nada);
  2. Fallback: cálculo local (Páscoa via Meeus + feriados fixos/móveis) — sempre
     disponível, sem dependências.

Assim a sincronização funciona mesmo sem a biblioteca instalada.
"""
import logging
from datetime import date, timedelta

logger = logging.getLogger(__name__)


def domingo_de_pascoa(ano: int) -> date:
    """Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher)."""
    a = ano % 19
    b = ano // 100
    c = ano % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    ll = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ll) // 451
    mes = (h + ll - 7 * m + 114) // 31
    dia = (h + ll - 7 * m + 114) % 31
    return date(ano, mes, dia + 1)


def feriados_b3(ano: int) -> dict:
    """Feriados da B3 (sem pregão) do ano, incluindo os móveis da Páscoa."""
    pascoa = domingo_de_pascoa(ano)
    feriados = {
        f"{ano}-01-01": "Confraternização Universal",
        f"{ano}-04-21": "Tiradentes",
        f"{ano}-05-01": "Dia do Trabalho",
        f"{ano}-09-07": "Independência do Brasil",
        f"{ano}-10-12": "Nossa Senhora Aparecida",
        f"{ano}-11-02": "Finados",
        f"{ano}-11-15": "Proclamação da República",
        f"{ano}-12-25": "Natal",
        f"{ano}-12-24": "Véspera de Natal (B3 sem pregão)",
        f"{ano}-12-31": "Véspera de Ano-Novo (B3 sem pregão)",
        (pascoa - timedelta(days=48)).isoformat(): "Carnaval (segunda)",
        (pascoa - timedelta(days=47)).isoformat(): "Carnaval (terça)",
        (pascoa - timedelta(days=2)).isoformat(): "Sexta-feira Santa",
        (pascoa + timedelta(days=60)).isoformat(): "Corpus Christi",
    }
    if ano >= 2024:
        feriados[f"{ano}-11-20"] = "Consciência Negra"
    return feriados


def _via_pandas(anos) -> dict:
    """Feriados da B3 via pandas_market_calendars (pode lançar se indisponível)."""
    import pandas as pd
    import pandas_market_calendars as mcal

    cal = None
    for nome in ("B3", "BMF", "BVMF"):
        try:
            cal = mcal.get_calendar(nome)
            break
        except Exception:
            continue
    if cal is None:
        raise RuntimeError("Calendário B3 não encontrado na biblioteca.")

    out = {}
    for h in cal.holidays().holidays:
        d = pd.Timestamp(h).date()
        if d.year in anos:
            out[d.isoformat()] = "Feriado B3 (calendário oficial)"
    if not out:
        raise RuntimeError("Biblioteca não retornou feriados para os anos pedidos.")
    return out


def sincronizar(db, anos) -> tuple[int, str]:
    """
    Garante os feriados B3 dos `anos` no banco (idempotente).
    Retorna (qtd_novos, fonte). Usa a biblioteca; se falhar, o cálculo local.
    """
    from app.models import Feriado

    anos = set(anos)
    try:
        mapa = _via_pandas(anos)
        fonte = "pandas_market_calendars"
    except Exception as exc:
        logger.info("Feriados B3 via cálculo local (biblioteca indisponível: %s).", exc)
        mapa = {}
        for ano in anos:
            mapa.update(feriados_b3(ano))
        fonte = "cálculo local"

    novos = 0
    for data_iso, desc in sorted(mapa.items()):
        if db.get(Feriado, data_iso) is None:
            db.add(Feriado(data=data_iso, descricao=desc))
            novos += 1
    db.commit()
    return novos, fonte
