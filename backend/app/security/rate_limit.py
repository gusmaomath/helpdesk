"""
Rate-limit e anti-brute-force PERSISTENTES (em tabela).

Antes ficava em memória de processo — o que furava com múltiplos workers do
uvicorn (cada processo tinha sua própria contagem). Aqui o estado é o banco, via
a tabela `registros_rate`, então o limite vale para o sistema inteiro.

Cada evento relevante (falha de login, abertura de chamado) vira uma linha. A
contagem dentro de uma janela de tempo decide se bloqueia. Linhas antigas são
removidas de forma oportunista para a tabela não crescer sem limite.
"""
from datetime import timedelta

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import RegistroRate, agora_utc


def _limpar_antigos(db: Session, tipo: str, janela_seg: int) -> None:
    corte = agora_utc() - timedelta(seconds=janela_seg)
    db.execute(
        delete(RegistroRate).where(
            RegistroRate.tipo == tipo, RegistroRate.criado_em < corte
        )
    )


def contar(db: Session, tipo: str, chave: str, janela_seg: int) -> int:
    """Quantos eventos `tipo`/`chave` ocorreram na janela recente."""
    corte = agora_utc() - timedelta(seconds=janela_seg)
    return (
        db.query(RegistroRate)
        .filter(
            RegistroRate.tipo == tipo,
            RegistroRate.chave == str(chave),
            RegistroRate.criado_em >= corte,
        )
        .count()
    )


def registrar(db: Session, tipo: str, chave: str, commit: bool = True) -> None:
    db.add(RegistroRate(tipo=tipo, chave=str(chave)))
    if commit:
        db.commit()


def limpar(db: Session, tipo: str, chave: str, commit: bool = True) -> None:
    """Zera os registros de uma chave (ex.: login bem-sucedido)."""
    db.execute(
        delete(RegistroRate).where(
            RegistroRate.tipo == tipo, RegistroRate.chave == str(chave)
        )
    )
    if commit:
        db.commit()


def excedeu(db: Session, tipo: str, chave: str, limite: int, janela_seg: int) -> bool:
    """True se a chave já atingiu/ultrapassou o limite na janela."""
    _limpar_antigos(db, tipo, janela_seg)
    return contar(db, tipo, chave, janela_seg) >= limite
