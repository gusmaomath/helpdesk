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
from datetime import timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func
from sqlalchemy.orm import Session

import auditoria
from auth import (
    exigir_admin,
    ip_requisicao,
    obter_usuario_atual,
    verificar_senha,
)
from database import get_db
from estado import (
    ESTADOS_ENCERRADOS,
    ESTADOS_PAUSA_SLA,
    proximos_status,
    transicao_valida,
)
from models import (
    Auditoria,
    Categoria,
    Chamado,
    Comentario,
    Gravidade,
    StatusChamado,
    Subcategoria,
    Usuario,
    agora_utc,
)
from notificacoes import notificar
from schemas import (
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
    SubcategoriaCriar,
)
from serializar import serializar_chamado, serializar_detalhe
from sla import faixa_aging, status_sla

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
    atribuido: Optional[int] = Query(None),
    sla: Optional[str] = Query(None, description="ok | em_risco | vencido"),
    busca: Optional[str] = Query(None, max_length=150),
    limite: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    query = db.query(Chamado).filter(Chamado.excluido_em.is_(None))

    if status_filtro is not None:
        query = query.filter(Chamado.status == status_filtro)
    if gravidade_filtro is not None:
        query = query.filter(Chamado.gravidade == gravidade_filtro)
    if atribuido is not None:
        query = query.filter(Chamado.atribuido_a_id == atribuido)
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
    db.commit()
    db.refresh(chamado)
    notificar(
        destino=chamado.contato_retorno or "solicitante",
        assunto=f"Atualização no chamado {chamado.numero_protocolo}",
        corpo="A equipe de suporte respondeu seu chamado.",
    )
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

    abertos_status = {
        StatusChamado.ABERTO, StatusChamado.EM_ANDAMENTO,
        StatusChamado.AGUARDANDO_USUARIO, StatusChamado.REABERTO,
    }

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
            criado = c.criado_em
            resolvido = c.resolvido_em
            if criado.tzinfo is None:
                criado = criado.replace(tzinfo=timezone.utc)
            if resolvido.tzinfo is None:
                resolvido = resolvido.replace(tzinfo=timezone.utc)
            delta = (resolvido - criado).total_seconds() / 3600.0
            if delta >= 0:
                total_horas += delta; n_resolvidos += 1
        if c.avaliacao is not None:
            csat_soma += c.avaliacao.nota; csat_n += 1
        chave = c.criado_em.strftime("%Y-%m-%d")
        volume_map[chave] = volume_map.get(chave, 0) + 1

    tempo_medio = round(total_horas / n_resolvidos, 2) if n_resolvidos else None
    csat_medio = round(csat_soma / csat_n, 2) if csat_n else None
    volume = [{"data": d, "total": volume_map[d]} for d in sorted(volume_map)]

    return {
        "total_chamados": total,
        "abertos": abertos,
        "resolvidos": resolvidos,
        "tempo_medio_resolucao_horas": tempo_medio,
        "csat_medio": csat_medio,
        "por_status": por_status,
        "por_gravidade": por_gravidade,
        "por_prioridade": por_prioridade,
        "aging": aging,
        "sla": sla_contagem,
        "workload": workload,
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
