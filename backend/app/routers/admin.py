"""
Rotas administrativas / operacionais.

TODAS exigem nível ADMINISTRADOR (dependência no nível do router). O admin
vê e atende TODOS os chamados — não há escopo por papel aqui. Usuários comuns
e líderes usam /api/chamados (que aplica o escopo "próprios + subordinados
diretos").

Endpoints:
  GET   /api/admin/chamados                 -> lista com filtros + escopo
  GET   /api/admin/chamados/{id}            -> detalhe completo (com internos)
  PUT   /api/admin/chamados/{id}/responder  -> resposta pública (vira comentário)
  POST  /api/admin/chamados/{id}/comentarios-> comentário interno/público
  PUT   /api/admin/chamados/{id}/status     -> transição validada (state machine)
  PUT   /api/admin/chamados/{id}/classificacao -> ajusta triagem/atribuição
  PUT   /api/admin/chamados/{id}/encerramento  -> causa raiz/solução/prevenção
  GET   /api/admin/dashboard                -> métricas (incl. aging, SLA, workload)
  GET   /api/admin/auditoria                -> trilha de auditoria (paginada)
  GET   /api/admin/categorias               -> taxonomia
  POST  /api/admin/categorias               -> cria categoria
  POST  /api/admin/subcategorias            -> cria subcategoria
"""
import csv
import io
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.services import auditoria
from app.services import busca
from app.security.auth import (
    exigir_admin,
    ip_requisicao,
    obter_usuario_atual,
    verificar_senha,
)
from app.database import get_db
from app.services.estado import (
    ESTADOS_ENCERRADOS,
    ESTADOS_PAUSA_SLA,
    proximos_status,
    transicao_valida,
)
from app.models import (
    Artigo,
    Auditoria,
    Categoria,
    Chamado,
    Comentario,
    Feriado,
    Gravidade,
    ParametroSla,
    StatusChamado,
    Subcategoria,
    Tag,
    Template,
    Usuario,
    agora_utc,
)
from app.services.notificacoes import notificar_usuario
from app.schemas import (
    AcaoMassa,
    ArtigoCriar,
    ArtigoResposta,
    CategoriaCriar,
    CategoriaResposta,
    ChamadoAlterarStatus,
    ChamadoAtualizarClassificacao,
    ChamadoDetalhe,
    ChamadoEncerrar,
    ChamadoResponder,
    ChamadoResposta,
    ComentarioCriar,
    ComentarioResposta,
    ConfirmacaoCredencial,
    FeriadoItem,
    MesclarRequest,
    ParametrosSlaRequest,
    SubcategoriaCriar,
    TagsRequest,
    TemplateBase,
    TemplateResposta,
)
from app.services.serializar import serializar_chamado, serializar_detalhe
from app.services.sla import faixa_aging, status_sla

# TODO o painel administrativo é restrito a ADMINISTRADOR. A dependência no
# nível do router garante isso em todas as rotas abaixo — não há escopo por
# papel aqui: admin vê TUDO.
router = APIRouter(
    prefix="/api/admin",
    tags=["Administração"],
    dependencies=[Depends(exigir_admin)],
)


# --------------------------------------------------------------------------- #
# Listagem / detalhe
# --------------------------------------------------------------------------- #
@router.get("/chamados", response_model=list[ChamadoResposta])
def listar_chamados(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
    status_filtro: Optional[StatusChamado] = Query(None, alias="status"),
    gravidade_filtro: Optional[Gravidade] = Query(None, alias="gravidade"),
    categoria: Optional[int] = Query(None),
    atribuido: Optional[int] = Query(None),
    sla: Optional[str] = Query(None, description="ok | em_risco | vencido"),
    tag: Optional[str] = Query(None, max_length=40),
    de: Optional[str] = Query(None, description="data inicial YYYY-MM-DD"),
    ate: Optional[str] = Query(None, description="data final YYYY-MM-DD"),
    busca: Optional[str] = Query(None, max_length=150),
    limite: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    query = db.query(Chamado).filter(Chamado.excluido_em.is_(None))

    if status_filtro is not None:
        query = query.filter(Chamado.status == status_filtro)
    if gravidade_filtro is not None:
        query = query.filter(Chamado.gravidade == gravidade_filtro)
    if categoria is not None:
        query = query.filter(Chamado.categoria_id == categoria)
    if tag:
        query = query.filter(Chamado.tags.any(Tag.nome == tag.strip().lower()))
    if atribuido is not None:
        query = query.filter(Chamado.atribuido_a_id == atribuido)
    if de:
        try:
            query = query.filter(Chamado.criado_em >= datetime.fromisoformat(de))
        except ValueError:
            pass
    if ate:
        try:
            # inclui o dia inteiro de 'ate'
            fim = datetime.fromisoformat(ate)
            query = query.filter(Chamado.criado_em <= fim.replace(hour=23, minute=59, second=59))
        except ValueError:
            pass
    if busca:
        termo = f"%{busca.strip()}%"
        query = query.filter(
            Chamado.titulo.ilike(termo) | Chamado.numero_protocolo.ilike(termo)
        )

    query = query.order_by(
        Chamado.prioridade.desc().nullslast(), Chamado.criado_em.desc()
    )
    chamados = query.offset(offset).limit(limite).all()

    resultado = [serializar_chamado(c) for c in chamados]
    # Filtro de SLA é derivado (não está no banco) -> aplica em Python.
    if sla:
        resultado = [c for c in resultado if c.sla_status == sla]
    return resultado


def _buscar_chamado(db: Session, chamado_id: int) -> Chamado:
    chamado = (
        db.query(Chamado)
        .filter(Chamado.id == chamado_id, Chamado.excluido_em.is_(None))
        .first()
    )
    if chamado is None:
        raise HTTPException(404, "Chamado não encontrado.")
    return chamado


@router.post("/chamados/acao-massa")
def acao_em_massa(
    dados: AcaoMassa,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Aplica uma ação a vários chamados de uma vez: atribuir responsável, mudar
    status (validado pela máquina de estados) ou cancelar (com motivo). Cada
    item é processado individualmente; transições inválidas são puladas.
    """
    chamados = (
        db.query(Chamado)
        .filter(Chamado.id.in_(dados.ids), Chamado.excluido_em.is_(None))
        .all()
    )
    aplicados, pulados = 0, 0
    novo_status = None
    if dados.acao in ("status", "cancelar"):
        try:
            novo_status = (
                StatusChamado.CANCELADO if dados.acao == "cancelar"
                else StatusChamado(dados.valor)
            )
        except ValueError:
            raise HTTPException(422, "Status inválido.")
    if dados.acao == "cancelar" and (not dados.motivo or len(dados.motivo.strip()) < 5):
        raise HTTPException(422, "Informe um motivo (mín. 5 caracteres) para cancelar.")

    for c in chamados:
        if dados.acao == "atribuir":
            c.atribuido_a_id = int(dados.valor) if dados.valor else None
            c.versao_linha += 1
            aplicados += 1
        else:  # status / cancelar
            if not transicao_valida(c.status, novo_status):
                pulados += 1
                continue
            if novo_status in ESTADOS_ENCERRADOS and c.resolvido_em is None:
                c.resolvido_em = agora_utc()
            elif novo_status not in ESTADOS_ENCERRADOS:
                c.resolvido_em = None
            if dados.acao == "cancelar":
                db.add(Comentario(
                    chamado_id=c.id, autor_id=usuario.id, interno=False,
                    corpo=f"Chamado cancelado em lote. Motivo: {dados.motivo.strip()}",
                ))
            c.status = novo_status
            c.versao_linha += 1
            aplicados += 1

    auditoria.registrar(
        db, usuario=usuario, acao="acao_em_massa", entidade="chamado",
        detalhe={"acao": dados.acao, "qtd": aplicados, "pulados": pulados},
        ip=ip_requisicao(request),
    )
    db.commit()
    return {"aplicados": aplicados, "pulados": pulados}


@router.get("/chamados/{chamado_id}", response_model=ChamadoDetalhe)
def detalhar(
    chamado_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _buscar_chamado(db, chamado_id)
    det = serializar_detalhe(chamado, incluir_internos=True)
    # Anexa as transições válidas para a UI montar o seletor de status.
    return det


@router.get("/chamados/{chamado_id}/transicoes")
def transicoes(
    chamado_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _buscar_chamado(db, chamado_id)
    return {
        "atual": chamado.status.value,
        "permitidos": [s.value for s in proximos_status(chamado.status)],
    }


# --------------------------------------------------------------------------- #
# Optimistic locking
# --------------------------------------------------------------------------- #
def _checar_versao(chamado: Chamado, versao_cliente: Optional[int]) -> None:
    if versao_cliente is not None and versao_cliente != chamado.versao_linha:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="O chamado foi alterado por outra pessoa. Recarregue e tente de novo.",
        )


# --------------------------------------------------------------------------- #
# Resposta / comentários
# --------------------------------------------------------------------------- #
@router.put("/chamados/{chamado_id}/responder", response_model=ChamadoDetalhe)
def responder(
    chamado_id: int,
    dados: ChamadoResponder,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _buscar_chamado(db, chamado_id)
    # Resposta pública = comentário visível ao solicitante.
    db.add(Comentario(
        chamado_id=chamado.id, autor_id=usuario.id, corpo=dados.resposta, interno=False
    ))
    if chamado.status == StatusChamado.ABERTO:
        chamado.status = StatusChamado.EM_ANDAMENTO
    # Assume a si se ainda não há responsável.
    if chamado.atribuido_a_id is None:
        chamado.atribuido_a_id = usuario.id
    chamado.versao_linha += 1
    auditoria.registrar(
        db, usuario=usuario, acao="resposta_publica", entidade="chamado",
        entidade_id=chamado.id, ip=ip_requisicao(request),
    )
    notificar_usuario(
        db, chamado.autor_id,
        titulo=f"Resposta no chamado {chamado.numero_protocolo}",
        corpo="A equipe de suporte respondeu seu chamado.",
        entidade="chamado", entidade_id=chamado.id,
    )
    db.commit()
    db.refresh(chamado)
    return serializar_detalhe(chamado, incluir_internos=True)


@router.post("/chamados/{chamado_id}/comentarios", response_model=ComentarioResposta)
def comentar_admin(
    chamado_id: int,
    dados: ComentarioCriar,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _buscar_chamado(db, chamado_id)
    comentario = Comentario(
        chamado_id=chamado.id, autor_id=usuario.id,
        corpo=dados.corpo, interno=dados.interno,
    )
    db.add(comentario)
    auditoria.registrar(
        db, usuario=usuario,
        acao="comentario_interno" if dados.interno else "comentario_publico",
        entidade="chamado", entidade_id=chamado.id, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(comentario)
    return ComentarioResposta.model_validate(comentario)


# --------------------------------------------------------------------------- #
# Transição de status (máquina de estados + pausa de SLA)
# --------------------------------------------------------------------------- #
@router.put("/chamados/{chamado_id}/status", response_model=ChamadoDetalhe)
def alterar_status(
    chamado_id: int,
    dados: ChamadoAlterarStatus,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _buscar_chamado(db, chamado_id)
    _checar_versao(chamado, dados.versao_linha)

    atual, novo = chamado.status, dados.status
    if not transicao_valida(atual, novo):
        raise HTTPException(
            422,
            f"Transição inválida: '{atual.value}' -> '{novo.value}'. "
            f"Permitidos: {[s.value for s in proximos_status(atual)]}.",
        )

    agora = agora_utc()

    # --- Pausa/retomada do relógio de SLA ---
    saindo_de_pausa = atual in ESTADOS_PAUSA_SLA and novo not in ESTADOS_PAUSA_SLA
    entrando_em_pausa = novo in ESTADOS_PAUSA_SLA and atual not in ESTADOS_PAUSA_SLA
    if entrando_em_pausa:
        chamado.sla_pausado_em = agora
    if saindo_de_pausa and chamado.sla_pausado_em is not None:
        pausado = chamado.sla_pausado_em
        if pausado.tzinfo is None:
            pausado = pausado.replace(tzinfo=timezone.utc)
        chamado.sla_segundos_pausado += int((agora - pausado).total_seconds())
        chamado.sla_pausado_em = None

    # --- Carimbo de resolução ---
    if novo in ESTADOS_ENCERRADOS:
        if chamado.resolvido_em is None:
            chamado.resolvido_em = agora
    else:
        chamado.resolvido_em = None  # reabriu

    chamado.status = novo
    chamado.versao_linha += 1
    auditoria.registrar(
        db, usuario=usuario, acao="status_alterado", entidade="chamado",
        entidade_id=chamado.id,
        detalhe={"de": atual.value, "para": novo.value},
        ip=ip_requisicao(request),
    )
    # Avisa o solicitante das transições mais relevantes.
    if novo in (StatusChamado.RESOLVIDO, StatusChamado.FECHADO):
        notificar_usuario(
            db, chamado.autor_id,
            titulo=f"Chamado {chamado.numero_protocolo} {novo.value}",
            corpo="Seu chamado foi atualizado pela equipe de suporte.",
            entidade="chamado", entidade_id=chamado.id,
        )
    db.commit()
    db.refresh(chamado)
    return serializar_detalhe(chamado, incluir_internos=True)


# --------------------------------------------------------------------------- #
# Classificação / atribuição (correção da triagem da IA)
# --------------------------------------------------------------------------- #
@router.put("/chamados/{chamado_id}/classificacao", response_model=ChamadoDetalhe)
def atualizar_classificacao(
    chamado_id: int,
    dados: ChamadoAtualizarClassificacao,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _buscar_chamado(db, chamado_id)
    _checar_versao(chamado, dados.versao_linha)

    mudancas = {}
    if dados.categoria_id is not None:
        chamado.categoria_id = dados.categoria_id; mudancas["categoria_id"] = dados.categoria_id
    if dados.subcategoria_id is not None:
        chamado.subcategoria_id = dados.subcategoria_id
    if dados.gravidade is not None:
        mudancas["gravidade"] = dados.gravidade.value
        chamado.gravidade = dados.gravidade
    if dados.prioridade is not None:
        chamado.prioridade = dados.prioridade; mudancas["prioridade"] = dados.prioridade
    if dados.impacto_negocio is not None:
        chamado.impacto_negocio = dados.impacto_negocio
    if dados.atribuido_a_id is not None:
        chamado.atribuido_a_id = dados.atribuido_a_id; mudancas["atribuido_a"] = dados.atribuido_a_id
        # Avisa o novo responsável pelo sininho.
        notificar_usuario(
            db, dados.atribuido_a_id,
            titulo=f"Chamado {chamado.numero_protocolo} atribuído a você",
            corpo=chamado.titulo, entidade="chamado", entidade_id=chamado.id,
        )

    chamado.versao_linha += 1
    auditoria.registrar(
        db, usuario=usuario, acao="classificacao_ajustada", entidade="chamado",
        entidade_id=chamado.id, detalhe=mudancas, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(chamado)
    return serializar_detalhe(chamado, incluir_internos=True)


# --------------------------------------------------------------------------- #
# Encerramento (causa raiz / solução / prevenção)
# --------------------------------------------------------------------------- #
@router.put("/chamados/{chamado_id}/encerramento", response_model=ChamadoDetalhe)
def registrar_encerramento(
    chamado_id: int,
    dados: ChamadoEncerrar,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _buscar_chamado(db, chamado_id)
    if dados.causa_raiz is not None:
        chamado.causa_raiz = dados.causa_raiz
    if dados.solucao_aplicada is not None:
        chamado.solucao_aplicada = dados.solucao_aplicada
    if dados.acao_preventiva is not None:
        chamado.acao_preventiva = dados.acao_preventiva
    chamado.versao_linha += 1
    auditoria.registrar(
        db, usuario=usuario, acao="encerramento_registrado", entidade="chamado",
        entidade_id=chamado.id, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(chamado)
    return serializar_detalhe(chamado, incluir_internos=True)


# --------------------------------------------------------------------------- #
# Dashboard / métricas
# --------------------------------------------------------------------------- #
@router.get("/dashboard")
def dashboard(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    base = db.query(Chamado).filter(Chamado.excluido_em.is_(None))
    chamados = base.all()

    total = len(chamados)
    por_status = {s.value: 0 for s in StatusChamado}
    por_gravidade = {g.value: 0 for g in Gravidade}
    por_prioridade = {str(i): 0 for i in range(1, 6)}
    aging = {"0-4h": 0, "4-24h": 0, "1-3d": 0, ">3d": 0}
    sla_contagem = {"ok": 0, "em_risco": 0, "vencido": 0, "sem_sla": 0}
    workload: dict[str, int] = {}
    volume_map: dict[str, int] = {}
    abertos = resolvidos = 0
    total_horas = 0.0
    n_resolvidos = 0
    csat_soma = csat_n = 0
    # SLA cumprido: entre os resolvidos com prazo, quantos dentro do prazo.
    sla_com_prazo = sla_no_prazo = 0
    # CSAT detalhado: nome -> [soma, n]
    csat_analista: dict[str, list] = {}
    csat_categoria: dict[str, list] = {}

    abertos_status = {
        StatusChamado.ABERTO, StatusChamado.EM_ANDAMENTO,
        StatusChamado.AGUARDANDO_USUARIO, StatusChamado.REABERTO,
    }

    def _aware(dt):
        return dt.replace(tzinfo=timezone.utc) if dt and dt.tzinfo is None else dt

    for c in chamados:
        por_status[c.status.value] += 1
        if c.gravidade:
            por_gravidade[c.gravidade.value] += 1
        if c.prioridade:
            por_prioridade[str(c.prioridade)] += 1
        if c.status in abertos_status:
            abertos += 1
            aging[faixa_aging(c.criado_em)] += 1
            sla_contagem[status_sla(c.sla_prazo)] += 1
            nome = c.atribuido_a.nome if c.atribuido_a else "Sem responsável"
            workload[nome] = workload.get(nome, 0) + 1
        if c.status in (StatusChamado.RESOLVIDO, StatusChamado.FECHADO):
            resolvidos += 1
        if c.resolvido_em is not None:
            criado = _aware(c.criado_em)
            resolvido = _aware(c.resolvido_em)
            delta = (resolvido - criado).total_seconds() / 3600.0
            if delta >= 0:
                total_horas += delta; n_resolvidos += 1
            # Cumprimento de SLA (resolvido <= prazo).
            if c.sla_prazo is not None:
                sla_com_prazo += 1
                if resolvido <= _aware(c.sla_prazo):
                    sla_no_prazo += 1
        if c.avaliacao is not None:
            csat_soma += c.avaliacao.nota; csat_n += 1
            quem = c.atribuido_a.nome if c.atribuido_a else "Sem responsável"
            csat_analista.setdefault(quem, [0, 0])
            csat_analista[quem][0] += c.avaliacao.nota; csat_analista[quem][1] += 1
            cat = c.categoria.nome if c.categoria else "Sem categoria"
            csat_categoria.setdefault(cat, [0, 0])
            csat_categoria[cat][0] += c.avaliacao.nota; csat_categoria[cat][1] += 1
        chave = c.criado_em.strftime("%Y-%m-%d")
        volume_map[chave] = volume_map.get(chave, 0) + 1

    tempo_medio = round(total_horas / n_resolvidos, 2) if n_resolvidos else None
    csat_medio = round(csat_soma / csat_n, 2) if csat_n else None
    sla_cumprimento = round(100 * sla_no_prazo / sla_com_prazo, 1) if sla_com_prazo else None
    volume = [{"data": d, "total": volume_map[d]} for d in sorted(volume_map)]
    media = lambda d: {k: round(v[0] / v[1], 2) for k, v in d.items() if v[1]}
    # Deflexões: quantas vezes um usuário resolveu com sugestão e NÃO abriu chamado.
    deflexoes = (
        db.query(Auditoria).filter(Auditoria.acao == "deflexao_aproveitada").count()
    )

    return {
        "total_chamados": total,
        "abertos": abertos,
        "resolvidos": resolvidos,
        "tempo_medio_resolucao_horas": tempo_medio,
        "csat_medio": csat_medio,
        "sla_cumprimento": sla_cumprimento,
        "deflexoes": deflexoes,
        "por_status": por_status,
        "por_gravidade": por_gravidade,
        "por_prioridade": por_prioridade,
        "aging": aging,
        "sla": sla_contagem,
        "workload": workload,
        "csat_por_analista": media(csat_analista),
        "csat_por_categoria": media(csat_categoria),
        "volume_ultimos_dias": volume,
    }


# --------------------------------------------------------------------------- #
# Auditoria
# --------------------------------------------------------------------------- #
@router.get("/auditoria")
def listar_auditoria(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(exigir_admin),
    entidade_id: Optional[int] = Query(None),
    limite: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    q = db.query(Auditoria)
    if entidade_id is not None:
        q = q.filter(Auditoria.entidade_id == entidade_id)
    eventos = q.order_by(Auditoria.criado_em.desc()).offset(offset).limit(limite).all()
    return [
        {
            "id": e.id,
            "usuario": e.usuario_nome,
            "acao": e.acao,
            "entidade": e.entidade,
            "entidade_id": e.entidade_id,
            "detalhe": e.detalhe,
            "ip": e.ip,
            "criado_em": e.criado_em.isoformat(),
        }
        for e in eventos
    ]


# --------------------------------------------------------------------------- #
# Base de conhecimento / chamados similares (FTS5)
# --------------------------------------------------------------------------- #
@router.get("/chamados/{chamado_id}/similares")
def chamados_similares(
    chamado_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """Chamados parecidos (FTS5) — apoia deduplicação e reuso de solução."""
    chamado = _buscar_chamado(db, chamado_id)
    return busca.similares(db, chamado, limite=5)


@router.post("/chamados/{chamado_id}/promover-artigo", response_model=ArtigoResposta, status_code=201)
def promover_artigo(
    chamado_id: int,
    dados: ArtigoCriar,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """Promove a solução de um chamado a artigo da base de conhecimento."""
    chamado = _buscar_chamado(db, chamado_id)
    artigo = Artigo(
        titulo=dados.titulo,
        conteudo=dados.conteudo,
        chamado_origem_id=chamado.id,
        criado_por_id=usuario.id,
    )
    db.add(artigo)
    auditoria.registrar(
        db, usuario=usuario, acao="artigo_promovido", entidade="artigo",
        entidade_id=chamado.id, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(artigo)
    return artigo


@router.get("/kb")
def base_conhecimento(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
    busca_termo: Optional[str] = Query(None, alias="busca", max_length=150),
):
    """Busca na base de conhecimento (FTS5). Sem termo, lista os mais recentes."""
    return busca.buscar_kb(db, busca_termo or "", limite=15)


# --------------------------------------------------------------------------- #
# Exportação CSV (relatório)
# --------------------------------------------------------------------------- #
@router.get("/exportacao/chamados.csv")
def exportar_csv(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """Exporta todos os chamados (não excluídos) em CSV para análise/relatório."""
    chamados = (
        db.query(Chamado)
        .filter(Chamado.excluido_em.is_(None))
        .order_by(Chamado.criado_em.desc())
        .all()
    )

    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow([
        "protocolo", "titulo", "status", "gravidade", "prioridade",
        "impacto", "solicitante", "responsavel", "criado_em", "resolvido_em",
        "sla_status",
    ])
    for c in chamados:
        w.writerow([
            c.numero_protocolo or c.id,
            c.titulo,
            c.status.value,
            c.gravidade.value if c.gravidade else "",
            c.prioridade or "",
            c.impacto_negocio.value if c.impacto_negocio else "",
            c.autor.nome if c.autor else "",
            c.atribuido_a.nome if c.atribuido_a else "",
            c.criado_em.strftime("%Y-%m-%d %H:%M") if c.criado_em else "",
            c.resolvido_em.strftime("%Y-%m-%d %H:%M") if c.resolvido_em else "",
            status_sla(c.sla_prazo),
        ])
    buf.seek(0)

    # ﻿ (BOM) para o Excel reconhecer UTF-8 com acentos corretamente.
    conteudo = "﻿" + buf.getvalue()
    return StreamingResponse(
        iter([conteudo]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=chamados.csv"},
    )


# --------------------------------------------------------------------------- #
# Taxonomia (categorias / subcategorias)
# --------------------------------------------------------------------------- #
@router.get("/categorias", response_model=list[CategoriaResposta])
def listar_categorias(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    return db.query(Categoria).order_by(Categoria.nome).all()


@router.post("/categorias", response_model=CategoriaResposta, status_code=201)
def criar_categoria(
    dados: CategoriaCriar,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(exigir_admin),
):
    if db.query(Categoria).filter(Categoria.nome == dados.nome).first():
        raise HTTPException(409, "Categoria já existe.")
    cat = Categoria(nome=dados.nome)
    db.add(cat)
    db.commit()
    db.refresh(cat)
    return cat


# --------------------------------------------------------------------------- #
# Reset do banco (DESTRUTIVO — exige re-confirmação de credenciais)
# --------------------------------------------------------------------------- #
@router.post("/reset-db")
def resetar_banco(
    dados: ConfirmacaoCredencial,
    request: Request,
    db: Session = Depends(get_db),
    admin: Usuario = Depends(exigir_admin),
):
    """
    APAGA e recria o banco com os dados de seed. Ação irreversível.

    Dupla proteção:
      1) Exige sessão de ADMINISTRADOR (dependência exigir_admin).
      2) Exige re-confirmação da matrícula + senha DO PRÓPRIO admin logado
         (defesa contra cliques acidentais e sessão deixada aberta).
    """
    if dados.matricula != admin.matricula or not verificar_senha(
        dados.senha, admin.senha_hash
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciais de confirmação inválidas.",
        )

    auditoria.registrar(
        db, usuario=admin, acao="reset_banco", entidade="sistema",
        ip=ip_requisicao(request), commit=True,
    )

    # Importado aqui para evitar dependência circular no carregamento do módulo.
    import seed
    seed.executar_seed(reset=True)

    return {
        "detail": "Banco resetado e repopulado. As credenciais padrão de seed "
                  "foram restauradas (admin / Admin@1234).",
    }


@router.post("/subcategorias", status_code=201)
def criar_subcategoria(
    dados: SubcategoriaCriar,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(exigir_admin),
):
    if db.get(Categoria, dados.categoria_id) is None:
        raise HTTPException(404, "Categoria não encontrada.")
    sub = Subcategoria(nome=dados.nome, categoria_id=dados.categoria_id)
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return {"id": sub.id, "nome": sub.nome, "categoria_id": sub.categoria_id}


# --------------------------------------------------------------------------- #
# Templates de chamado (modelos pré-preenchidos)
# --------------------------------------------------------------------------- #
@router.get("/templates", response_model=list[TemplateResposta])
def listar_templates(db: Session = Depends(get_db), usuario: Usuario = Depends(obter_usuario_atual)):
    return db.query(Template).order_by(Template.nome).all()


@router.post("/templates", response_model=TemplateResposta, status_code=201)
def criar_template(dados: TemplateBase, db: Session = Depends(get_db), admin: Usuario = Depends(exigir_admin)):
    t = Template(**dados.model_dump())
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


@router.put("/templates/{template_id}", response_model=TemplateResposta)
def atualizar_template(template_id: int, dados: TemplateBase, db: Session = Depends(get_db), admin: Usuario = Depends(exigir_admin)):
    t = db.get(Template, template_id)
    if t is None:
        raise HTTPException(404, "Modelo não encontrado.")
    for k, v in dados.model_dump().items():
        setattr(t, k, v)
    db.commit()
    db.refresh(t)
    return t


@router.delete("/templates/{template_id}", status_code=204)
def excluir_template(template_id: int, db: Session = Depends(get_db), admin: Usuario = Depends(exigir_admin)):
    t = db.get(Template, template_id)
    if t is None:
        raise HTTPException(404, "Modelo não encontrado.")
    db.delete(t)
    db.commit()


# --------------------------------------------------------------------------- #
# Tags (etiquetas) de um chamado
# --------------------------------------------------------------------------- #
@router.get("/tags")
def listar_tags(db: Session = Depends(get_db), usuario: Usuario = Depends(obter_usuario_atual)):
    return [t.nome for t in db.query(Tag).order_by(Tag.nome).all()]


@router.put("/chamados/{chamado_id}/tags", response_model=ChamadoDetalhe)
def definir_tags(
    chamado_id: int,
    dados: TagsRequest,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """Substitui as etiquetas do chamado (cria as que não existem)."""
    chamado = _buscar_chamado(db, chamado_id)
    novas = []
    for nome in dados.tags:
        tag = db.query(Tag).filter(Tag.nome == nome).first()
        if tag is None:
            tag = Tag(nome=nome)
            db.add(tag)
            db.flush()
        novas.append(tag)
    chamado.tags = novas
    chamado.versao_linha += 1
    auditoria.registrar(
        db, usuario=usuario, acao="tags_alteradas", entidade="chamado",
        entidade_id=chamado.id, detalhe={"tags": dados.tags}, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(chamado)
    return serializar_detalhe(chamado, incluir_internos=True)


# --------------------------------------------------------------------------- #
# Mesclar chamados duplicados
# --------------------------------------------------------------------------- #
@router.post("/chamados/{chamado_id}/mesclar", response_model=ChamadoDetalhe)
def mesclar_chamado(
    chamado_id: int,
    dados: MesclarRequest,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Mescla o chamado {chamado_id} (duplicado) no chamado {destino_id} (principal):
    move comentários e anexos, encerra o duplicado como CANCELADO e registra o
    vínculo. Retorna o chamado PRINCIPAL atualizado.
    """
    if dados.destino_id == chamado_id:
        raise HTTPException(422, "Escolha um chamado de destino diferente.")
    dup = _buscar_chamado(db, chamado_id)
    principal = _buscar_chamado(db, dados.destino_id)
    if dup.status in ESTADOS_ENCERRADOS:
        raise HTTPException(422, "O chamado a mesclar já está encerrado.")

    for com in list(dup.comentarios):
        com.chamado_id = principal.id
    for anx in list(dup.anexos):
        anx.chamado_id = principal.id

    dup.status = StatusChamado.CANCELADO
    dup.resolvido_em = agora_utc()
    dup.mesclado_em_id = principal.id
    dup.versao_linha += 1
    principal.versao_linha += 1
    db.add(Comentario(
        chamado_id=principal.id, autor_id=usuario.id, interno=True,
        corpo=f"Chamado {dup.numero_protocolo} mesclado neste por {usuario.nome}.",
    ))
    db.add(Comentario(
        chamado_id=dup.id, autor_id=usuario.id, interno=False,
        corpo=f"Mesclado no chamado {principal.numero_protocolo}.",
    ))
    auditoria.registrar(
        db, usuario=usuario, acao="chamado_mesclado", entidade="chamado",
        entidade_id=dup.id, detalhe={"destino": principal.id}, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(principal)
    return serializar_detalhe(principal, incluir_internos=True)


# --------------------------------------------------------------------------- #
# Configuração de SLA (horas por prioridade) e feriados
# --------------------------------------------------------------------------- #
@router.get("/config/sla")
def obter_config_sla(db: Session = Depends(get_db), usuario: Usuario = Depends(obter_usuario_atual)):
    horas = {p.prioridade: p.horas for p in db.query(ParametroSla).all()}
    if not horas:
        from app.config import config as cfg
        horas = dict(cfg.SLA_HORAS_POR_PRIORIDADE)
    feriados = [
        {"data": f.data, "descricao": f.descricao}
        for f in db.query(Feriado).order_by(Feriado.data).all()
    ]
    return {"horas_por_prioridade": horas, "feriados": feriados}


@router.put("/config/sla")
def salvar_config_sla(dados: ParametrosSlaRequest, db: Session = Depends(get_db), admin: Usuario = Depends(exigir_admin)):
    for item in dados.itens:
        p = db.get(ParametroSla, item.prioridade)
        if p is None:
            db.add(ParametroSla(prioridade=item.prioridade, horas=item.horas))
        else:
            p.horas = item.horas
    db.commit()
    return {"detail": "Parâmetros de SLA atualizados."}


@router.post("/config/feriados", status_code=201)
def adicionar_feriado(dados: FeriadoItem, db: Session = Depends(get_db), admin: Usuario = Depends(exigir_admin)):
    if db.get(Feriado, dados.data) is not None:
        raise HTTPException(409, "Feriado já cadastrado nessa data.")
    db.add(Feriado(data=dados.data, descricao=dados.descricao))
    db.commit()
    return {"detail": "Feriado adicionado."}


@router.delete("/config/feriados/{data}", status_code=204)
def remover_feriado(data: str, db: Session = Depends(get_db), admin: Usuario = Depends(exigir_admin)):
    f = db.get(Feriado, data)
    if f is None:
        raise HTTPException(404, "Feriado não encontrado.")
    db.delete(f)
    db.commit()
