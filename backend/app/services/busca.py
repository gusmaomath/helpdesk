"""
Busca textual com FTS5 (full-text search nativo do SQLite).

Mantém duas tabelas virtuais sincronizadas por gatilhos (triggers):
- `chamados_fts`  -> para "chamados parecidos com este" (deduplicação/handoff)
- `artigos_fts`   -> para a base de conhecimento (KB)

Sem dependências externas e sem embeddings: o FTS5 dá ranking por relevância
(bm25) suficiente para um helpdesk interno. Se o SQLite tiver sido compilado
sem FTS5 (raríssimo), as funções degradam para lista vazia em vez de quebrar.
"""
import re

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

_FTS_OK = False

# Palavras curtas/comuns que não ajudam na busca por similaridade.
_STOP = {
    "de", "da", "do", "os", "as", "um", "uma", "no", "na", "em", "para", "por",
    "com", "que", "the", "and", "nao", "não", "sem", "meu", "minha", "esta",
    "está", "ao", "aos",
}


def garantir_fts(engine: Engine) -> None:
    """Cria as tabelas FTS e os gatilhos (idempotente). Chamado no startup."""
    global _FTS_OK
    if not str(engine.url).startswith("sqlite"):
        return
    try:
        with engine.begin() as conn:
            # --- Chamados ---
            conn.exec_driver_sql(
                "CREATE VIRTUAL TABLE IF NOT EXISTS chamados_fts "
                "USING fts5(titulo, descricao, content='chamados', content_rowid='id')"
            )
            for trig in (
                """CREATE TRIGGER IF NOT EXISTS chamados_ai AFTER INSERT ON chamados BEGIN
                       INSERT INTO chamados_fts(rowid, titulo, descricao)
                       VALUES (new.id, new.titulo, new.descricao);
                   END;""",
                """CREATE TRIGGER IF NOT EXISTS chamados_ad AFTER DELETE ON chamados BEGIN
                       INSERT INTO chamados_fts(chamados_fts, rowid, titulo, descricao)
                       VALUES ('delete', old.id, old.titulo, old.descricao);
                   END;""",
                """CREATE TRIGGER IF NOT EXISTS chamados_au AFTER UPDATE ON chamados BEGIN
                       INSERT INTO chamados_fts(chamados_fts, rowid, titulo, descricao)
                       VALUES ('delete', old.id, old.titulo, old.descricao);
                       INSERT INTO chamados_fts(rowid, titulo, descricao)
                       VALUES (new.id, new.titulo, new.descricao);
                   END;""",
            ):
                conn.exec_driver_sql(trig)
            # Reindexa a partir da tabela de conteúdo. Em FTS5 de conteúdo
            # externo, o jeito correto é o comando 'rebuild' (INSERT...SELECT
            # manual desalinha o índice). Sempre reconstruir no boot garante
            # consistência mesmo após `seed.py --reset` (que não dropa as
            # tabelas virtuais). Custo desprezível neste volume.
            conn.exec_driver_sql(
                "INSERT INTO chamados_fts(chamados_fts) VALUES('rebuild')"
            )

            # --- Artigos (KB) ---
            conn.exec_driver_sql(
                "CREATE VIRTUAL TABLE IF NOT EXISTS artigos_fts "
                "USING fts5(titulo, conteudo, content='artigos', content_rowid='id')"
            )
            for trig in (
                """CREATE TRIGGER IF NOT EXISTS artigos_ai AFTER INSERT ON artigos BEGIN
                       INSERT INTO artigos_fts(rowid, titulo, conteudo)
                       VALUES (new.id, new.titulo, new.conteudo);
                   END;""",
                """CREATE TRIGGER IF NOT EXISTS artigos_ad AFTER DELETE ON artigos BEGIN
                       INSERT INTO artigos_fts(artigos_fts, rowid, titulo, conteudo)
                       VALUES ('delete', old.id, old.titulo, old.conteudo);
                   END;""",
                """CREATE TRIGGER IF NOT EXISTS artigos_au AFTER UPDATE ON artigos BEGIN
                       INSERT INTO artigos_fts(artigos_fts, rowid, titulo, conteudo)
                       VALUES ('delete', old.id, old.titulo, old.conteudo);
                       INSERT INTO artigos_fts(rowid, titulo, conteudo)
                       VALUES (new.id, new.titulo, new.conteudo);
                   END;""",
            ):
                conn.exec_driver_sql(trig)
            # Reindexa artigos (ex.: criados pelo seed antes da FTS existir).
            conn.exec_driver_sql(
                "INSERT INTO artigos_fts(artigos_fts) VALUES('rebuild')"
            )
        _FTS_OK = True
    except Exception as exc:  # pragma: no cover - resiliência
        print(f"[FTS] indisponível, busca textual desativada: {exc}")
        _FTS_OK = False


def _consulta(texto: str) -> str:
    """
    Monta uma query FTS5 segura a partir de texto livre: extrai termos
    relevantes e os une com OR, cada um entre aspas (literal) para evitar erros
    de sintaxe com caracteres especiais.
    """
    termos = re.findall(r"[\wáéíóúâêôãõçà]{3,}", (texto or "").lower())
    termos = [t for t in termos if t not in _STOP][:12]
    if not termos:
        return ""
    vistos, unicos = set(), []
    for t in termos:
        if t not in vistos:
            vistos.add(t)
            unicos.append(f'"{t}"')
    return " OR ".join(unicos)


def _buscar_similares(db, texto, exclude_id, limite, apenas_resolvidos):
    """Núcleo da busca de chamados similares por texto livre."""
    if not _FTS_OK:
        return []
    q = _consulta(texto)
    if not q:
        return []
    # O Enum é gravado pelo NOME em maiúsculas ('RESOLVIDO'); o filtro raw usa isso.
    filtro_status = (
        "AND c.status IN ('RESOLVIDO', 'FECHADO') " if apenas_resolvidos else ""
    )
    try:
        linhas = db.execute(
            text(
                "SELECT c.id, c.numero_protocolo, c.titulo, c.status "
                "FROM chamados_fts JOIN chamados c ON c.id = chamados_fts.rowid "
                "WHERE chamados_fts MATCH :q AND c.id != :self "
                "AND c.excluido_em IS NULL "
                f"{filtro_status}"
                "ORDER BY rank LIMIT :lim"
            ),
            {"q": q, "self": exclude_id or -1, "lim": limite},
        ).all()
        # status vem como nome ('RESOLVIDO'); .lower() dá o value ('resolvido').
        return [
            {"id": r[0], "numero_protocolo": r[1], "titulo": r[2],
             "status": str(r[3]).lower()}
            for r in linhas
        ]
    except Exception:
        return []


def similares(db: Session, chamado, limite: int = 5) -> list[dict]:
    """Chamados parecidos com `chamado` (para o atendimento), exceto ele."""
    return _buscar_similares(
        db, f"{chamado.titulo} {chamado.descricao}",
        exclude_id=chamado.id, limite=limite, apenas_resolvidos=False,
    )


def similares_por_texto(db: Session, titulo: str, descricao: str,
                        limite: int = 4) -> list[dict]:
    """
    Para DEFLEXÃO: dado o texto que o usuário está digitando, sugere chamados
    JÁ RESOLVIDOS/FECHADOS parecidos (provável fonte de solução). Devolve só
    título/protocolo/status — sem expor descrição/internos de terceiros.
    """
    return _buscar_similares(
        db, f"{titulo} {descricao}", exclude_id=None,
        limite=limite, apenas_resolvidos=True,
    )


def buscar_kb(db: Session, termo: str, limite: int = 10) -> list[dict]:
    """Busca artigos da base de conhecimento por relevância."""
    if not _FTS_OK:
        return []
    q = _consulta(termo)
    try:
        if q:
            linhas = db.execute(
                text(
                    "SELECT a.id, a.titulo, a.conteudo, a.chamado_origem_id "
                    "FROM artigos_fts JOIN artigos a ON a.id = artigos_fts.rowid "
                    "WHERE artigos_fts MATCH :q ORDER BY rank LIMIT :lim"
                ),
                {"q": q, "lim": limite},
            ).all()
        else:
            linhas = db.execute(
                text(
                    "SELECT id, titulo, conteudo, chamado_origem_id "
                    "FROM artigos ORDER BY criado_em DESC LIMIT :lim"
                ),
                {"lim": limite},
            ).all()
        return [
            {"id": r[0], "titulo": r[1], "conteudo": r[2], "chamado_origem_id": r[3]}
            for r in linhas
        ]
    except Exception:
        return []
