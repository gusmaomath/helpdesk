"""
Escalonamento automático por SLA (job em background).

Até aqui o `sla_status` era só *calculado na leitura* — nada agia sozinho.
Aqui uma thread daemon varre periodicamente os chamados em aberto cujo prazo de
SLA já venceu e ainda não foram escalados, e:
  1. marca `sla_escalado_em` (evita escalar/notificar em loop);
  2. notifica o SUPERIOR do responsável (ou a gestão) via `notificacoes`;
  3. registra na trilha de auditoria.

Usa uma thread + sessão própria (o ORM é síncrono) em vez de async, para não
acoplar ao event loop. Intervalo em `config.ESCALONAMENTO_INTERVALO_SEGUNDOS`
(0 desativa).
"""
import threading
import time

from app.services import auditoria
from app.services import notificacoes
from app.config import config
from app.database import SessionLocal
from app.models import Chamado, StatusChamado, Usuario, agora_utc

# Estados "ativos" cujo SLA vencido deve escalar (aguardando_usuario está pausado).
_ESTADOS_ESCALAVEIS = [
    StatusChamado.ABERTO,
    StatusChamado.EM_ANDAMENTO,
    StatusChamado.REABERTO,
]


def verificar_sla_uma_vez() -> int:
    """Escala os chamados com SLA vencido ainda não escalados. Retorna a contagem."""
    db = SessionLocal()
    try:
        agora = agora_utc()
        candidatos = (
            db.query(Chamado)
            .filter(
                Chamado.excluido_em.is_(None),
                Chamado.sla_prazo.isnot(None),
                Chamado.sla_prazo < agora,
                Chamado.sla_escalado_em.is_(None),
                Chamado.status.in_(_ESTADOS_ESCALAVEIS),
            )
            .all()
        )
        for c in candidatos:
            c.sla_escalado_em = agora

            # Destino: superior do responsável (escala "pra cima"); senão, gestão.
            destino = "gestao-suporte"
            if c.atribuido_a_id:
                resp = db.get(Usuario, c.atribuido_a_id)
                if resp and resp.supervisor and resp.supervisor.email:
                    destino = resp.supervisor.email

            notificacoes.notificar(
                destino=destino,
                assunto=f"⏰ SLA VENCIDO — {c.numero_protocolo}",
                corpo=f"O chamado '{c.titulo}' ({c.gravidade.value if c.gravidade else '?'}) "
                      f"ultrapassou o prazo de SLA e precisa de atenção.",
            )
            auditoria.registrar(
                db, usuario=None, acao="sla_escalado", entidade="chamado",
                entidade_id=c.id, detalhe={"prazo": str(c.sla_prazo)},
            )

            # ----------------------------------------------------------------- #
            # CONEXÃO FUTURA COM IA (desativada por enquanto)
            # Quando a IA proprietária estiver disponível, dá para enriquecer a
            # escalada com uma análise preditiva/sumária, por exemplo:
            #
            #   from ia import analisador_ativo
            #   insight = analisador_ativo.prever_risco(c)          # risco de estouro
            #   resumo  = analisador_ativo.resumir_para_handoff(c)  # resumo p/ o gestor
            #   notificacoes.notificar(destino, "Resumo IA", resumo)
            # ----------------------------------------------------------------- #

        db.commit()
        return len(candidatos)
    finally:
        db.close()


def iniciar_em_background() -> None:
    """Sobe a thread daemon de verificação periódica (se habilitada)."""
    intervalo = config.ESCALONAMENTO_INTERVALO_SEGUNDOS
    if intervalo <= 0:
        return

    def _loop():
        while True:
            time.sleep(intervalo)
            try:
                n = verificar_sla_uma_vez()
                if n:
                    print(f"[SLA] {n} chamado(s) escalado(s) por SLA vencido.")
            except Exception as exc:  # pragma: no cover - resiliência do worker
                print(f"[SLA] erro no verificador: {exc}")

    threading.Thread(target=_loop, daemon=True, name="sla-escalonamento").start()
