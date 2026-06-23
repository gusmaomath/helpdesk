"""
Modelos ORM (SQLAlchemy).

Tabelas do sistema:
- Usuario        : credenciais, papel hierárquico e supervisor (auto-relação).
- Categoria/Subcategoria : taxonomia editável pelo admin (sem deploy).
- Chamado        : o ticket, com campos operacionais ricos + triagem de IA.
- Comentario     : thread de interações (público ou interno) -> timeline.
- Anexo          : metadados de evidências (o binário fica em disco).
- Avaliacao      : pesquisa de satisfação (CSAT) pós-fechamento.
- Auditoria      : trilha imutável de "quem fez o quê e quando".

Decisões de segurança / robustez:
- Senhas NUNCA em texto puro (ver auth.py: hash bcrypt).
- Enums de domínio controlam valores e evitam lixo no banco.
- `versao_linha` habilita optimistic locking (anti-sobrescrita simultânea).
- `excluido_em` implementa soft-delete (nada some de verdade — auditoria).
"""
import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from database import Base


def agora_utc() -> datetime:
    """Retorna o instante atual em UTC (timezone-aware)."""
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Enums de domínio
# --------------------------------------------------------------------------- #
class NivelAcesso(str, enum.Enum):
    """Mantido por compatibilidade: distingue acesso ao painel admin."""
    USUARIO = "usuario"
    ADMINISTRADOR = "administrador"


class Papel(str, enum.Enum):
    """
    Papel hierárquico (escopo de visão).
    A ordem importa para o cálculo de "quem está acima de quem".
    """
    COLABORADOR = "colaborador"   # vê só os próprios chamados
    ANALISTA = "analista"         # vê a fila atribuída a si
    LIDER = "lider"               # vê a própria equipe (subordinados diretos)
    COORDENADOR = "coordenador"   # vê múltiplas equipes (subordinados em árvore)
    ADMINISTRADOR = "administrador"  # vê tudo

    @property
    def rank(self) -> int:
        ordem = {
            "colaborador": 1,
            "analista": 2,
            "lider": 3,
            "coordenador": 4,
            "administrador": 5,
        }
        return ordem[self.value]


class StatusChamado(str, enum.Enum):
    ABERTO = "aberto"
    EM_ANDAMENTO = "em_andamento"
    AGUARDANDO_USUARIO = "aguardando_usuario"
    RESOLVIDO = "resolvido"
    FECHADO = "fechado"
    REABERTO = "reaberto"
    CANCELADO = "cancelado"


class Gravidade(str, enum.Enum):
    BAIXA = "Baixa"
    MEDIA = "Média"
    ALTA = "Alta"
    CRITICA = "Crítica"


class ImpactoNegocio(str, enum.Enum):
    BAIXO = "baixo"
    MEDIO = "medio"
    ALTO = "alto"
    CRITICO = "critico"


class QualidadeDescritiva(str, enum.Enum):
    BOA = "boa"
    RUIM = "ruim"


# --------------------------------------------------------------------------- #
# Usuário (com hierarquia real)
# --------------------------------------------------------------------------- #
class Contador(Base):
    """
    Sequência atômica para numeração de protocolo (e o que mais precisar).

    Usar uma linha-contador com UPDATE atômico (em vez de COUNT(*)+1) elimina a
    condição de corrida quando muitos chamados são abertos ao mesmo tempo: o
    UPDATE adquire o write-lock do SQLite e serializa os incrementos.
    """
    __tablename__ = "contadores"

    chave = Column(String(40), primary_key=True)   # ex.: "protocolo-2026"
    valor = Column(Integer, nullable=False, default=0)


class Usuario(Base):
    __tablename__ = "usuarios"

    id = Column(Integer, primary_key=True, index=True)
    nome = Column(String(120), nullable=False)
    matricula = Column(String(50), unique=True, nullable=False, index=True)
    senha_hash = Column(String(255), nullable=False)

    # Acesso ao painel admin (compat) + papel hierárquico (escopo de visão).
    nivel_acesso = Column(
        Enum(NivelAcesso), default=NivelAcesso.USUARIO, nullable=False
    )
    papel = Column(Enum(Papel), default=Papel.COLABORADOR, nullable=False, index=True)

    # Auto-relação: "alguém acima de você".
    supervisor_id = Column(
        Integer, ForeignKey("usuarios.id"), nullable=True, index=True
    )
    supervisor = relationship(
        "Usuario", remote_side=[id], backref="subordinados"
    )

    unidade_setor = Column(String(120), nullable=True)   # agência/departamento
    email = Column(String(150), nullable=True)
    ramal = Column(String(30), nullable=True)

    ativo = Column(Integer, default=1, nullable=False)  # 1 ativo, 0 desativado
    criado_em = Column(DateTime(timezone=True), default=agora_utc, nullable=False)

    # Versão do token: incrementar invalida JWTs antigos (revogação imediata).
    token_version = Column(Integer, default=0, nullable=False)

    # Senha provisória: força troca no primeiro acesso (auto-cadastro / criação
    # pelo admin). Enquanto True, o usuário só pode trocar a senha.
    senha_provisoria = Column(Boolean, default=False, nullable=False)

    chamados = relationship(
        "Chamado",
        back_populates="autor",
        foreign_keys="Chamado.autor_id",
    )

    @property
    def eh_admin(self) -> bool:
        return self.nivel_acesso == NivelAcesso.ADMINISTRADOR


# --------------------------------------------------------------------------- #
# Taxonomia (editável pelo admin, sem precisar de deploy)
# --------------------------------------------------------------------------- #
class Categoria(Base):
    __tablename__ = "categorias"

    id = Column(Integer, primary_key=True, index=True)
    nome = Column(String(80), unique=True, nullable=False)
    ativo = Column(Boolean, default=True, nullable=False)

    subcategorias = relationship(
        "Subcategoria", back_populates="categoria", cascade="all, delete-orphan"
    )


class Subcategoria(Base):
    __tablename__ = "subcategorias"

    id = Column(Integer, primary_key=True, index=True)
    nome = Column(String(80), nullable=False)
    categoria_id = Column(
        Integer, ForeignKey("categorias.id"), nullable=False, index=True
    )
    ativo = Column(Boolean, default=True, nullable=False)

    categoria = relationship("Categoria", back_populates="subcategorias")


# --------------------------------------------------------------------------- #
# Chamado (ticket operacional completo)
# --------------------------------------------------------------------------- #
class Chamado(Base):
    __tablename__ = "chamados"

    id = Column(Integer, primary_key=True, index=True)
    # Protocolo legível para atendimento (ex.: 2026-000123). Gerado na criação.
    numero_protocolo = Column(String(20), unique=True, nullable=True, index=True)

    titulo = Column(String(150), nullable=False)
    descricao = Column(Text, nullable=False)

    status = Column(
        Enum(StatusChamado), default=StatusChamado.ABERTO, nullable=False, index=True
    )

    # --- Classificação operacional ---
    categoria_id = Column(Integer, ForeignKey("categorias.id"), nullable=True, index=True)
    subcategoria_id = Column(Integer, ForeignKey("subcategorias.id"), nullable=True)
    categoria = relationship("Categoria")
    subcategoria = relationship("Subcategoria")

    sistema_afetado = Column(String(80), nullable=True)   # ERP, CRM, E-mail, VPN...
    modulo_tela = Column(String(120), nullable=True)      # tela/módulo específico
    impacto_negocio = Column(Enum(ImpactoNegocio), nullable=True, index=True)
    urgencia_solicitante = Column(Integer, nullable=True)  # 1 a 5 (informada pelo user)
    unidade_setor = Column(String(120), nullable=True)
    contato_retorno = Column(String(120), nullable=True)   # ramal/e-mail/Teams

    # Janela de indisponibilidade percebida pelo solicitante.
    indisponibilidade_inicio = Column(DateTime(timezone=True), nullable=True)
    indisponibilidade_fim = Column(DateTime(timezone=True), nullable=True)

    # --- Triagem de IA (mock hoje, modelo real depois — contrato estável) ---
    gravidade = Column(Enum(Gravidade), nullable=True, index=True)
    prioridade = Column(Integer, nullable=True)  # 1 a 5 (calculada)
    qualidade_descritiva = Column(Enum(QualidadeDescritiva), nullable=True)
    analise_ia_versao = Column(String(50), nullable=True)
    ia_confianca = Column(Float, nullable=True)        # 0.0 a 1.0
    ia_justificativa = Column(Text, nullable=True)     # por que a IA classificou assim
    # Sugestão original da IA, preservada mesmo se um humano corrigir (dataset).
    ia_gravidade_sugerida = Column(Enum(Gravidade), nullable=True)
    categoria_sugerida = Column(String(80), nullable=True)

    # --- Encerramento (preenchido ao resolver/fechar) ---
    causa_raiz = Column(Text, nullable=True)
    solucao_aplicada = Column(Text, nullable=True)
    acao_preventiva = Column(Text, nullable=True)

    # --- Pessoas envolvidas ---
    autor_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, index=True)
    autor = relationship("Usuario", back_populates="chamados", foreign_keys=[autor_id])

    # Quem abriu (pode ser um analista abrindo em nome do solicitante).
    aberto_por_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    aberto_por = relationship("Usuario", foreign_keys=[aberto_por_id])

    # Analista responsável (atribuição/workload).
    atribuido_a_id = Column(
        Integer, ForeignKey("usuarios.id"), nullable=True, index=True
    )
    atribuido_a = relationship("Usuario", foreign_keys=[atribuido_a_id])

    # --- SLA ---
    # Prazo (deadline) calculado em horário comercial a partir da prioridade.
    sla_prazo = Column(DateTime(timezone=True), nullable=True)
    # Segundos acumulados em estados "pausados" (aguardando usuário).
    sla_segundos_pausado = Column(Integer, default=0, nullable=False)
    # Marca quando entrou no estado pausado (para somar ao despausar).
    sla_pausado_em = Column(DateTime(timezone=True), nullable=True)
    # Carimbo de quando o SLA vencido já foi escalado (evita notificar em loop).
    sla_escalado_em = Column(DateTime(timezone=True), nullable=True)

    # --- Timestamps ---
    criado_em = Column(
        DateTime(timezone=True), default=agora_utc, nullable=False, index=True
    )
    atualizado_em = Column(
        DateTime(timezone=True), default=agora_utc, onupdate=agora_utc, nullable=False
    )
    resolvido_em = Column(DateTime(timezone=True), nullable=True)

    # --- Controle de concorrência e soft-delete ---
    versao_linha = Column(Integer, default=1, nullable=False)  # optimistic lock
    excluido_em = Column(DateTime(timezone=True), nullable=True)  # soft delete

    comentarios = relationship(
        "Comentario", back_populates="chamado", cascade="all, delete-orphan"
    )
    anexos = relationship(
        "Anexo", back_populates="chamado", cascade="all, delete-orphan"
    )
    avaliacao = relationship(
        "Avaliacao", back_populates="chamado", uselist=False,
        cascade="all, delete-orphan",
    )

    @property
    def excluido(self) -> bool:
        return self.excluido_em is not None


# --------------------------------------------------------------------------- #
# Thread de comentários (timeline)
# --------------------------------------------------------------------------- #
class Comentario(Base):
    __tablename__ = "comentarios"

    id = Column(Integer, primary_key=True, index=True)
    chamado_id = Column(
        Integer, ForeignKey("chamados.id"), nullable=False, index=True
    )
    autor_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False)

    corpo = Column(Text, nullable=False)
    # interno=True: visível só para a equipe; False: visível ao solicitante.
    interno = Column(Boolean, default=False, nullable=False)

    criado_em = Column(
        DateTime(timezone=True), default=agora_utc, nullable=False, index=True
    )

    chamado = relationship("Chamado", back_populates="comentarios")
    autor = relationship("Usuario")


# --------------------------------------------------------------------------- #
# Anexos (apenas metadados — o binário vive em disco, fora do banco)
# --------------------------------------------------------------------------- #
class Anexo(Base):
    __tablename__ = "anexos"

    id = Column(Integer, primary_key=True, index=True)
    chamado_id = Column(
        Integer, ForeignKey("chamados.id"), nullable=False, index=True
    )
    nome_original = Column(String(255), nullable=False)
    caminho = Column(String(500), nullable=False)   # caminho relativo em uploads/
    tipo_mime = Column(String(120), nullable=True)
    tamanho_bytes = Column(Integer, nullable=True)
    sha256 = Column(String(64), nullable=True)       # integridade / dedup
    enviado_por_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    criado_em = Column(DateTime(timezone=True), default=agora_utc, nullable=False)

    chamado = relationship("Chamado", back_populates="anexos")


# --------------------------------------------------------------------------- #
# Pesquisa de satisfação (CSAT)
# --------------------------------------------------------------------------- #
class Avaliacao(Base):
    __tablename__ = "avaliacoes"

    id = Column(Integer, primary_key=True, index=True)
    chamado_id = Column(
        Integer, ForeignKey("chamados.id"), nullable=False, unique=True, index=True
    )
    nota = Column(Integer, nullable=False)            # 1 a 5 (CSAT)
    comentario = Column(Text, nullable=True)
    criado_em = Column(DateTime(timezone=True), default=agora_utc, nullable=False)

    chamado = relationship("Chamado", back_populates="avaliacao")


# --------------------------------------------------------------------------- #
# Trilha de auditoria (imutável)
# --------------------------------------------------------------------------- #
class Auditoria(Base):
    __tablename__ = "auditoria"

    id = Column(Integer, primary_key=True, index=True)
    # Quem (pode ser nulo para eventos do sistema).
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True, index=True)
    usuario_nome = Column(String(120), nullable=True)  # snapshot do nome na hora

    acao = Column(String(80), nullable=False, index=True)   # ex.: "status_alterado"
    entidade = Column(String(50), nullable=True)            # ex.: "chamado"
    entidade_id = Column(Integer, nullable=True, index=True)
    detalhe = Column(Text, nullable=True)                   # JSON/texto livre
    ip = Column(String(64), nullable=True)

    criado_em = Column(
        DateTime(timezone=True), default=agora_utc, nullable=False, index=True
    )

    usuario = relationship("Usuario")


# --------------------------------------------------------------------------- #
# Base de conhecimento (artigos promovidos a partir de chamados resolvidos)
# --------------------------------------------------------------------------- #
class Artigo(Base):
    __tablename__ = "artigos"

    id = Column(Integer, primary_key=True, index=True)
    titulo = Column(String(180), nullable=False)
    conteudo = Column(Text, nullable=False)
    chamado_origem_id = Column(Integer, ForeignKey("chamados.id"), nullable=True)
    criado_por_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    criado_em = Column(DateTime(timezone=True), default=agora_utc, nullable=False)
    atualizado_em = Column(
        DateTime(timezone=True), default=agora_utc, onupdate=agora_utc, nullable=False
    )

    criado_por = relationship("Usuario")


# --------------------------------------------------------------------------- #
# Rate-limit / brute force PERSISTENTE (em tabela, não em memória de processo).
# Cada tentativa relevante vira uma linha; a contagem por janela define bloqueio.
# Funciona mesmo com múltiplos workers do uvicorn (o estado é o banco).
# --------------------------------------------------------------------------- #
class RegistroRate(Base):
    __tablename__ = "registros_rate"

    id = Column(Integer, primary_key=True, index=True)
    # tipo: "login_falha" | "abertura_chamado"
    tipo = Column(String(40), nullable=False, index=True)
    # chave: matrícula (login) ou id do usuário (abertura)
    chave = Column(String(80), nullable=False, index=True)
    criado_em = Column(
        DateTime(timezone=True), default=agora_utc, nullable=False, index=True
    )
