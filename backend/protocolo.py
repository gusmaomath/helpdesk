"""
Geração de número de protocolo legível (ex.: 2026-000123), CONCORRÊNCIA-SAFE.

Por que não COUNT(*)+1?
    Duas aberturas simultâneas poderiam ler a mesma contagem e gerar o mesmo
    número — colisão. A unicidade da coluna `numero_protocolo` barraria a
    segunda, mas a custo de um erro 500 para o usuário.

Solução: uma linha-contador (`contadores`) incrementada por um UPDATE atômico.
No SQLite, o UPDATE adquire o write-lock e serializa os incrementos; com
`busy_timeout` (ver database.py), aberturas concorrentes ESPERAM o lock em vez
de falhar. O resultado é uma sequência contígua por ano, sem corrida.

Em produção com Postgres, o mesmo padrão funciona (ou troque por uma SEQUENCE
nativa). A interface pública `gerar_protocolo()` não muda.
"""
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session


def gerar_protocolo(db: Session) -> str:
    ano = datetime.now(timezone.utc).year
    chave = f"protocolo-{ano}"

    # 1) Garante a linha do contador do ano (idempotente, sem corrida).
    db.execute(
        text(
            "INSERT INTO contadores (chave, valor) VALUES (:c, 0) "
            "ON CONFLICT(chave) DO NOTHING"
        ),
        {"c": chave},
    )
    # 2) Incremento atômico (adquire o write-lock — serializa concorrentes).
    db.execute(
        text("UPDATE contadores SET valor = valor + 1 WHERE chave = :c"),
        {"c": chave},
    )
    # 3) Lê o valor recém-incrementado (mesma transação).
    valor = db.execute(
        text("SELECT valor FROM contadores WHERE chave = :c"), {"c": chave}
    ).scalar()

    return f"{ano}-{valor:06d}"
