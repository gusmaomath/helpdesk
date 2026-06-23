"""
Rotas de chamados (usuário comum / solicitante).

POST   /api/chamados                  -> abre um novo chamado (triagem de IA)
GET    /api/chamados                  -> lista os chamados do próprio usuário
GET    /api/chamados/{id}             -> detalha um chamado próprio
POST   /api/chamados/{id}/comentarios -> adiciona comentário público
POST   /api/chamados/{id}/avaliacao   -> registra CSAT (chamado encerrado)
POST   /api/chamados/{id}/anexos      -> envia evidência (upload)
"""
import hashlib
import os
import uuid

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.services import auditoria
from app.services import busca
from app.security import rate_limit
from app.security.auth import (
    ids_descendentes,
    ids_visiveis_para,
    ip_requisicao,
    obter_usuario_atual,
)
from app.config import config
from app.database import get_db
from app.services.estado import ESTADOS_ENCERRADOS
from app.services.ia import analisar_chamado
from app.models import (
    Anexo,
    Avaliacao,
    Categoria,
    Chamado,
    Comentario,
    Gravidade,
    NivelAcesso,
    QualidadeDescritiva,
    StatusChamado,
    Template,
    Usuario,
    agora_utc,
)
from app.services.notificacoes import notificar, notificar_usuario
from app.services.protocolo import gerar_protocolo
from app.schemas import (
    AvaliacaoCriar,
    AvaliacaoResposta,
    CancelarChamado,
    CategoriaResposta,
    ChamadoCriar,
    ChamadoDetalhe,
    ChamadoResposta,
    ComentarioCriar,
    ComentarioResposta,
    DeflexaoRequest,
    TemplateResposta,
)
from app.services.serializar import serializar_chamado, serializar_detalhe
from app.services.sla import calcular_prazo, carregar_parametros_sla

router = APIRouter(prefix="/api/chamados", tags=["Chamados"])

TIPO_ABERTURA = "abertura_chamado"


@router.post("", response_model=ChamadoDetalhe, status_code=status.HTTP_201_CREATED)
def abrir_chamado(
    dados: ChamadoCriar,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    # Rate limit por usuário, PERSISTENTE (tabela) — vale entre workers.
    if rate_limit.excedeu(
        db, TIPO_ABERTURA, usuario.id, config.MAX_CHAMADOS_POR_MINUTO, 60
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Limite de aberturas por minuto atingido. Aguarde um instante.",
        )
    rate_limit.registrar(db, TIPO_ABERTURA, usuario.id, commit=False)

    # Solicitante: por padrão é o próprio; um analista pode abrir em nome de outro.
    solicitante = usuario
    if dados.solicitante_id and dados.solicitante_id != usuario.id:
        if usuario.papel.rank < 2:  # apenas analista+ abre em nome de terceiro
            raise HTTPException(403, "Sem permissão para abrir em nome de outro.")
        alvo = db.query(Usuario).filter(Usuario.id == dados.solicitante_id).first()
        if alvo is None:
            raise HTTPException(404, "Solicitante informado não existe.")
        solicitante = alvo

    chamado = Chamado(
        titulo=dados.titulo,
        descricao=dados.descricao,
        autor_id=solicitante.id,
        aberto_por_id=usuario.id,
        categoria_id=dados.categoria_id,
        subcategoria_id=dados.subcategoria_id,
        sistema_afetado=dados.sistema_afetado,
        modulo_tela=dados.modulo_tela,
        impacto_negocio=dados.impacto_negocio,
        urgencia_solicitante=dados.urgencia_solicitante,
        unidade_setor=dados.unidade_setor or solicitante.unidade_setor,
        contato_retorno=dados.contato_retorno or solicitante.email or solicitante.ramal,
        indisponibilidade_inicio=dados.indisponibilidade_inicio,
        indisponibilidade_fim=dados.indisponibilidade_fim,
        numero_protocolo=gerar_protocolo(db),
    )

    # Triagem de IA (mock por enquanto; PII mascarada internamente).
    analise = analisar_chamado(dados.titulo, dados.descricao)
    chamado.gravidade = Gravidade(analise["gravidade"])
    chamado.prioridade = analise["prioridade"]
    chamado.qualidade_descritiva = QualidadeDescritiva(analise["qualidade_descritiva"])
    chamado.analise_ia_versao = analise["versao_modelo"]
    chamado.ia_confianca = analise["confianca"]
    chamado.ia_justificativa = analise["justificativa"]
    chamado.ia_gravidade_sugerida = Gravidade(analise["gravidade"])
    chamado.categoria_sugerida = analise["categoria_sugerida"]

    # SLA: prazo em horário comercial (parâmetros e feriados vêm do banco).
    horas_sla, feriados = carregar_parametros_sla(db)
    chamado.sla_prazo = calcular_prazo(
        agora_utc(), chamado.prioridade, horas_sla, feriados
    )

    db.add(chamado)
    db.flush()  # garante id para a auditoria
    auditoria.registrar(
        db, usuario=usuario, acao="chamado_aberto", entidade="chamado",
        entidade_id=chamado.id,
        detalhe={"protocolo": chamado.numero_protocolo, "gravidade": analise["gravidade"]},
        ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(chamado)

    # Notifica a fila (canal de log por enquanto; plugável p/ Teams/Slack).
    notificar(
        destino="fila-suporte",
        assunto=f"Novo chamado {chamado.numero_protocolo} ({analise['gravidade']})",
        corpo=f"{chamado.titulo} — solicitante {solicitante.nome}",
    )
    return serializar_detalhe(chamado, incluir_internos=False)


@router.get("/categorias", response_model=list[CategoriaResposta])
def listar_categorias_para_abertura(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Taxonomia ativa, disponível a QUALQUER usuário autenticado para preencher
    o formulário de abertura. Declarada antes de `/{chamado_id}` para que a
    rota literal tenha precedência sobre a rota com parâmetro.
    """
    return (
        db.query(Categoria)
        .filter(Categoria.ativo.is_(True))
        .order_by(Categoria.nome)
        .all()
    )


@router.get("/templates", response_model=list[TemplateResposta])
def listar_templates(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """Modelos de chamado ativos, para pré-preencher o formulário de abertura."""
    return (
        db.query(Template).filter(Template.ativo.is_(True)).order_by(Template.nome).all()
    )


@router.post("/deflexao/aproveitada")
def deflexao_aproveitada(
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Registra que o usuário resolveu com uma sugestão e NÃO abriu chamado
    (métrica de deflexão). Vira um KPI no painel.
    """
    auditoria.registrar(
        db, usuario=usuario, acao="deflexao_aproveitada", entidade="deflexao",
        ip=ip_requisicao(request), commit=True,
    )
    return {"detail": "Obrigado! Registramos que isto resolveu seu problema."}


@router.post("/deflexao")
def deflexao(
    dados: DeflexaoRequest,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Autoatendimento: a partir do que o usuário está digitando, sugere chamados
    JÁ RESOLVIDOS parecidos e artigos da base de conhecimento — para tentar
    resolver antes de abrir um novo chamado (deflexão).
    """
    texto = f"{dados.titulo} {dados.descricao}".strip()
    if len(texto) < 8:
        return {"similares": [], "artigos": []}
    return {
        "similares": busca.similares_por_texto(db, dados.titulo, dados.descricao, limite=4),
        "artigos": busca.buscar_kb(db, texto, limite=4),
    }


@router.get("/equipe")
def minha_equipe(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Lista TODA a cadeia abaixo do usuário (subárvore), com contadores de
    chamados. Alimenta a página "Minha equipe" e o filtro por solicitante.
    """
    ids = ids_descendentes(db, usuario)
    if not ids:
        return []

    membros = db.query(Usuario).filter(Usuario.id.in_(ids)).all()
    nomes = {u.id: u.nome for u in membros}
    nomes[usuario.id] = usuario.nome

    abertos_status = [
        StatusChamado.ABERTO, StatusChamado.EM_ANDAMENTO,
        StatusChamado.AGUARDANDO_USUARIO, StatusChamado.REABERTO,
    ]
    total = dict(
        db.query(Chamado.autor_id, func.count(Chamado.id))
        .filter(Chamado.autor_id.in_(ids), Chamado.excluido_em.is_(None))
        .group_by(Chamado.autor_id).all()
    )
    abertos = dict(
        db.query(Chamado.autor_id, func.count(Chamado.id))
        .filter(
            Chamado.autor_id.in_(ids),
            Chamado.status.in_(abertos_status),
            Chamado.excluido_em.is_(None),
        )
        .group_by(Chamado.autor_id).all()
    )

    return [
        {
            "id": m.id,
            "nome": m.nome,
            "matricula": m.matricula,
            "papel": m.papel.value,
            "unidade_setor": m.unidade_setor,
            "supervisor_id": m.supervisor_id,
            "supervisor_nome": nomes.get(m.supervisor_id),
            "total": total.get(m.id, 0),
            "abertos": abertos.get(m.id, 0),
        }
        for m in sorted(membros, key=lambda u: u.nome)
    ]


@router.get("", response_model=list[ChamadoResposta])
def listar_meus_chamados(
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Lista os chamados visíveis ao usuário: os PRÓPRIOS + os de TODA a cadeia
    abaixo dele na hierarquia (subárvore de subordinados).
    """
    ids = ids_visiveis_para(db, usuario)
    chamados = (
        db.query(Chamado)
        .filter(Chamado.autor_id.in_(ids), Chamado.excluido_em.is_(None))
        .order_by(Chamado.criado_em.desc())
        .all()
    )
    return [serializar_chamado(c) for c in chamados]


def _chamado_visivel_ou_404(db: Session, chamado_id: int, usuario: Usuario) -> Chamado:
    """Acesso de leitura: próprio OU de subordinado direto."""
    ids = ids_visiveis_para(db, usuario)
    chamado = (
        db.query(Chamado)
        .filter(
            Chamado.id == chamado_id,
            Chamado.autor_id.in_(ids),
            Chamado.excluido_em.is_(None),
        )
        .first()
    )
    if chamado is None:
        # 404 (e não 403) para não revelar a existência de chamados alheios.
        raise HTTPException(status_code=404, detail="Chamado não encontrado.")
    return chamado


def _meu_chamado_ou_404(db: Session, chamado_id: int, usuario: Usuario) -> Chamado:
    """Acesso de escrita (comentar/avaliar): SOMENTE o próprio chamado."""
    chamado = (
        db.query(Chamado)
        .filter(
            Chamado.id == chamado_id,
            Chamado.autor_id == usuario.id,
            Chamado.excluido_em.is_(None),
        )
        .first()
    )
    if chamado is None:
        raise HTTPException(status_code=404, detail="Chamado não encontrado.")
    return chamado


@router.get("/{chamado_id}", response_model=ChamadoDetalhe)
def detalhar_meu_chamado(
    chamado_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _chamado_visivel_ou_404(db, chamado_id, usuario)
    # Solicitante / supervisor NÃO veem comentários internos da equipe.
    return serializar_detalhe(chamado, incluir_internos=False)


@router.post("/{chamado_id}/comentarios", response_model=ComentarioResposta)
def comentar(
    chamado_id: int,
    dados: ComentarioCriar,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _meu_chamado_ou_404(db, chamado_id, usuario)
    # Solicitante só pode criar comentário PÚBLICO.
    comentario = Comentario(
        chamado_id=chamado.id, autor_id=usuario.id, corpo=dados.corpo, interno=False
    )
    db.add(comentario)
    # Reabre o relógio do lado da equipe: se aguardava o usuário, volta ao fluxo.
    if chamado.status == StatusChamado.AGUARDANDO_USUARIO:
        chamado.status = StatusChamado.EM_ANDAMENTO
    auditoria.registrar(
        db, usuario=usuario, acao="comentario_solicitante", entidade="chamado",
        entidade_id=chamado.id, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(comentario)
    return ComentarioResposta.model_validate(comentario)


@router.post("/{chamado_id}/avaliacao", response_model=AvaliacaoResposta)
def avaliar(
    chamado_id: int,
    dados: AvaliacaoCriar,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _meu_chamado_ou_404(db, chamado_id, usuario)
    if chamado.status not in ESTADOS_ENCERRADOS:
        raise HTTPException(400, "Só é possível avaliar chamados encerrados.")
    if chamado.avaliacao is not None:
        raise HTTPException(409, "Este chamado já foi avaliado.")
    avaliacao = Avaliacao(
        chamado_id=chamado.id, nota=dados.nota, comentario=dados.comentario
    )
    db.add(avaliacao)
    db.commit()
    db.refresh(avaliacao)
    return AvaliacaoResposta.model_validate(avaliacao)


@router.post("/{chamado_id}/cancelar", response_model=ChamadoDetalhe)
def cancelar_chamado(
    chamado_id: int,
    dados: CancelarChamado,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Cancela um chamado. Permitido ao DONO (retirar o próprio) ou a qualquer
    SUPERIOR na cadeia (ancestral do dono) — ambos com justificativa.

    Como `ids_visiveis_para` = {próprio} ∪ {toda a cadeia abaixo}, basta que o
    autor do chamado esteja nesse conjunto: ou é você, ou está abaixo de você.
    """
    chamado = _chamado_visivel_ou_404(db, chamado_id, usuario)

    # Não cancela o que já está encerrado (resolvido/fechado/cancelado).
    if chamado.status in ESTADOS_ENCERRADOS:
        raise HTTPException(
            status_code=422,
            detail="Este chamado já está encerrado e não pode ser cancelado.",
        )

    eh_dono = chamado.autor_id == usuario.id
    chamado.status = StatusChamado.CANCELADO
    chamado.resolvido_em = agora_utc()
    chamado.versao_linha += 1

    rotulo = "pelo solicitante" if eh_dono else f"pelo superior {usuario.nome}"
    db.add(Comentario(
        chamado_id=chamado.id, autor_id=usuario.id, interno=False,
        corpo=f"Chamado cancelado {rotulo}. Motivo: {dados.motivo}",
    ))
    auditoria.registrar(
        db, usuario=usuario, acao="chamado_cancelado", entidade="chamado",
        entidade_id=chamado.id,
        detalhe={"dono": eh_dono, "motivo": dados.motivo},
        ip=ip_requisicao(request),
    )
    # Se cancelado por um superior, avisa o dono pelo sininho.
    if not eh_dono:
        notificar_usuario(
            db, chamado.autor_id,
            titulo=f"Chamado {chamado.numero_protocolo} cancelado",
            corpo=f"Cancelado por {usuario.nome}. Motivo: {dados.motivo}",
            entidade="chamado", entidade_id=chamado.id,
        )
    db.commit()
    db.refresh(chamado)
    return serializar_detalhe(chamado, incluir_internos=False)


@router.post("/{chamado_id}/reabrir", response_model=ChamadoDetalhe)
def reabrir_chamado(
    chamado_id: int,
    request: Request,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Reabertura formal pelo SOLICITANTE de um chamado já encerrado
    (resolvido/fechado/cancelado). Recalcula o SLA a partir de agora.
    """
    chamado = _meu_chamado_ou_404(db, chamado_id, usuario)
    if chamado.status not in (
        StatusChamado.RESOLVIDO, StatusChamado.FECHADO, StatusChamado.CANCELADO
    ):
        raise HTTPException(422, "Só é possível reabrir um chamado encerrado.")

    horas_sla, feriados = carregar_parametros_sla(db)
    chamado.status = StatusChamado.REABERTO
    chamado.resolvido_em = None
    chamado.sla_prazo = calcular_prazo(agora_utc(), chamado.prioridade, horas_sla, feriados)
    chamado.versao_linha += 1
    db.add(Comentario(
        chamado_id=chamado.id, autor_id=usuario.id, interno=False,
        corpo="Chamado reaberto pelo solicitante.",
    ))
    auditoria.registrar(
        db, usuario=usuario, acao="chamado_reaberto", entidade="chamado",
        entidade_id=chamado.id, ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(chamado)
    notificar(
        destino="fila-suporte",
        assunto=f"Chamado {chamado.numero_protocolo} reaberto",
        corpo=f"O solicitante reabriu o chamado: {chamado.titulo}",
    )
    return serializar_detalhe(chamado, incluir_internos=False)


@router.post("/{chamado_id}/anexos")
def enviar_anexo(
    chamado_id: int,
    request: Request,
    arquivo: UploadFile = File(...),
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    chamado = _meu_chamado_ou_404(db, chamado_id, usuario)

    # Validação de extensão (vetor clássico de ataque).
    _, ext = os.path.splitext(arquivo.filename or "")
    ext = ext.lower()
    if ext not in config.EXTENSOES_PERMITIDAS:
        raise HTTPException(400, f"Extensão não permitida: {ext or 'sem extensão'}.")

    conteudo = arquivo.file.read()
    if len(conteudo) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Arquivo excede o tamanho máximo permitido.")

    os.makedirs(config.UPLOAD_DIR, exist_ok=True)
    nome_disco = f"{uuid.uuid4().hex}{ext}"
    caminho = os.path.join(config.UPLOAD_DIR, nome_disco)
    with open(caminho, "wb") as f:
        f.write(conteudo)

    anexo = Anexo(
        chamado_id=chamado.id,
        nome_original=arquivo.filename or nome_disco,
        caminho=nome_disco,
        tipo_mime=arquivo.content_type,
        tamanho_bytes=len(conteudo),
        sha256=hashlib.sha256(conteudo).hexdigest(),
        enviado_por_id=usuario.id,
    )
    db.add(anexo)
    auditoria.registrar(
        db, usuario=usuario, acao="anexo_enviado", entidade="chamado",
        entidade_id=chamado.id, detalhe={"nome": anexo.nome_original},
        ip=ip_requisicao(request),
    )
    db.commit()
    db.refresh(anexo)
    return {"id": anexo.id, "nome_original": anexo.nome_original}


@router.get("/{chamado_id}/anexos/{anexo_id}")
def baixar_anexo(
    chamado_id: int,
    anexo_id: int,
    db: Session = Depends(get_db),
    usuario: Usuario = Depends(obter_usuario_atual),
):
    """
    Baixa um anexo. Acesso: quem enxerga o chamado (próprio/subordinado) OU
    qualquer administrador (que vê tudo).
    """
    ids = ids_visiveis_para(db, usuario)
    chamado = (
        db.query(Chamado)
        .filter(Chamado.id == chamado_id, Chamado.excluido_em.is_(None))
        .first()
    )
    eh_admin = usuario.nivel_acesso == NivelAcesso.ADMINISTRADOR
    if chamado is None or (chamado.autor_id not in ids and not eh_admin):
        raise HTTPException(404, "Chamado não encontrado.")

    anexo = (
        db.query(Anexo)
        .filter(Anexo.id == anexo_id, Anexo.chamado_id == chamado_id)
        .first()
    )
    if anexo is None:
        raise HTTPException(404, "Anexo não encontrado.")

    caminho = os.path.join(config.UPLOAD_DIR, anexo.caminho)
    if not os.path.isfile(caminho):
        raise HTTPException(404, "Arquivo não disponível.")

    return FileResponse(
        caminho,
        media_type=anexo.tipo_mime or "application/octet-stream",
        filename=anexo.nome_original,
    )
