"""
Conversão de modelos ORM -> schemas de resposta, com campos derivados.

Centraliza a lógica de:
- preencher `sla_status` (ok / em_risco / vencido) a partir do prazo;
- expor `resposta_suporte` (compat com o front antigo) como o último
  comentário PÚBLICO do chamado;
- montar os nomes de categoria/subcategoria.
"""
from typing import Optional

from app.models import Chamado, Comentario
from app.schemas import (
    AutorResumo,
    ChamadoDetalhe,
    ChamadoResposta,
)
from app.services.sla import status_sla


def _ultimo_publico(chamado: Chamado) -> Optional[str]:
    publicos = [c for c in chamado.comentarios if not c.interno]
    if not publicos:
        return None
    publicos.sort(key=lambda c: c.criado_em)
    return publicos[-1].corpo


def serializar_chamado(chamado: Chamado) -> ChamadoResposta:
    base = ChamadoResposta.model_validate(chamado)
    base.resposta_suporte = _ultimo_publico(chamado)
    base.sla_prazo = chamado.sla_prazo
    base.sla_status = status_sla(chamado.sla_prazo)
    if chamado.atribuido_a is not None:
        base.atribuido_a = AutorResumo.model_validate(chamado.atribuido_a)
    return base


def serializar_detalhe(
    chamado: Chamado, *, incluir_internos: bool
) -> ChamadoDetalhe:
    det = ChamadoDetalhe.model_validate(chamado)
    det.resposta_suporte = _ultimo_publico(chamado)
    det.sla_prazo = chamado.sla_prazo
    det.sla_status = status_sla(chamado.sla_prazo)
    det.categoria_nome = chamado.categoria.nome if chamado.categoria else None
    det.subcategoria_nome = (
        chamado.subcategoria.nome if chamado.subcategoria else None
    )
    if chamado.atribuido_a is not None:
        det.atribuido_a = AutorResumo.model_validate(chamado.atribuido_a)
    det.tags = sorted(t.nome for t in chamado.tags)

    # Filtra comentários internos para quem não é da equipe.
    comentarios = sorted(chamado.comentarios, key=lambda c: c.criado_em)
    if not incluir_internos:
        comentarios = [c for c in comentarios if not c.interno]
    det.comentarios = [_coment(c) for c in comentarios]
    return det


def _coment(c: Comentario):
    from app.schemas import ComentarioResposta
    return ComentarioResposta.model_validate(c)
