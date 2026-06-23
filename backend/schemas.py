"""
Schemas Pydantic (validação e serialização).

Primeira linha de defesa contra entradas maliciosas:
- Limites de tamanho (anti-DoS / anti-abuso).
- Strip de espaços e validação de campos obrigatórios.
- Sanitização básica de HTML (escapando caracteres perigosos) para mitigar XSS.

O front-end também escapa na renderização (defesa em profundidade), mas nunca
confiamos só no cliente.
"""
import html
import re
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from auth import validar_senha_forte
from config import config
from models import (
    Gravidade,
    ImpactoNegocio,
    NivelAcesso,
    Papel,
    QualidadeDescritiva,
    StatusChamado,
)


def _sanitizar(texto: str) -> str:
    texto = texto.strip()
    texto = re.sub(r"[ \t]+", " ", texto)
    texto = re.sub(r"\n{3,}", "\n\n", texto)
    return html.escape(texto)


def _sanitizar_opcional(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    v = v.strip()
    return _sanitizar(v) if v else None


# --------------------------------------------------------------------------- #
# Autenticação
# --------------------------------------------------------------------------- #
class LoginRequest(BaseModel):
    matricula: str
    senha: str

    @field_validator("matricula")
    @classmethod
    def validar_matricula(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Matrícula é obrigatória.")
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,50}", v):
            raise ValueError("Matrícula contém caracteres inválidos.")
        return v


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    id: int
    nome: str
    nivel_acesso: NivelAcesso
    papel: Papel
    senha_provisoria: bool = False


class TrocarSenha(BaseModel):
    senha_atual: str
    nova_senha: str

    @field_validator("nova_senha")
    @classmethod
    def validar_nova(cls, v: str) -> str:
        erro = validar_senha_forte(v)
        if erro:
            raise ValueError(erro)
        return v


class AutoCadastro(BaseModel):
    """Auto-cadastro público: cria usuário PENDENTE (inativo) p/ aprovação."""
    nome: str
    matricula: str
    senha: str
    email: Optional[str] = None
    unidade_setor: Optional[str] = None

    @field_validator("nome")
    @classmethod
    def validar_nome(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Nome muito curto.")
        return _sanitizar(v)

    @field_validator("matricula")
    @classmethod
    def validar_matricula(cls, v: str) -> str:
        v = v.strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,50}", v):
            raise ValueError("Matrícula inválida.")
        return v

    @field_validator("senha")
    @classmethod
    def validar_senha(cls, v: str) -> str:
        erro = validar_senha_forte(v)
        if erro:
            raise ValueError(erro)
        return v

    @field_validator("email", "unidade_setor")
    @classmethod
    def san(cls, v):
        return _sanitizar_opcional(v)


class ConfirmacaoCredencial(BaseModel):
    """Re-autenticação para ações destrutivas (ex.: reset do banco)."""
    matricula: str
    senha: str


# --------------------------------------------------------------------------- #
# Usuário (com hierarquia)
# --------------------------------------------------------------------------- #
class UsuarioCriar(BaseModel):
    nome: str
    matricula: str
    senha: str
    nivel_acesso: NivelAcesso = NivelAcesso.USUARIO
    papel: Papel = Papel.COLABORADOR
    supervisor_id: Optional[int] = None
    unidade_setor: Optional[str] = None
    email: Optional[str] = None
    ramal: Optional[str] = None

    @field_validator("nome")
    @classmethod
    def validar_nome(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Nome muito curto.")
        return _sanitizar(v)

    @field_validator("matricula")
    @classmethod
    def validar_matricula(cls, v: str) -> str:
        v = v.strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,50}", v):
            raise ValueError("Matrícula inválida.")
        return v

    @field_validator("senha")
    @classmethod
    def validar_senha(cls, v: str) -> str:
        erro = validar_senha_forte(v)
        if erro:
            raise ValueError(erro)
        return v

    @field_validator("unidade_setor", "email", "ramal")
    @classmethod
    def san_opcionais(cls, v):
        return _sanitizar_opcional(v)


class UsuarioAtualizar(BaseModel):
    """Edição administrativa (todos os campos opcionais)."""
    nome: Optional[str] = None
    nivel_acesso: Optional[NivelAcesso] = None
    papel: Optional[Papel] = None
    supervisor_id: Optional[int] = None
    unidade_setor: Optional[str] = None
    email: Optional[str] = None
    ramal: Optional[str] = None
    ativo: Optional[bool] = None
    nova_senha: Optional[str] = None

    @field_validator("nova_senha")
    @classmethod
    def validar_senha(cls, v):
        if v is None:
            return v
        erro = validar_senha_forte(v)
        if erro:
            raise ValueError(erro)
        return v

    @field_validator("nome", "unidade_setor", "email", "ramal")
    @classmethod
    def san_opcionais(cls, v):
        return _sanitizar_opcional(v)


class SupervisorResumo(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    nome: str
    matricula: str


class UsuarioResposta(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    nome: str
    matricula: str
    nivel_acesso: NivelAcesso
    papel: Papel
    supervisor_id: Optional[int] = None
    unidade_setor: Optional[str] = None
    email: Optional[str] = None
    ramal: Optional[str] = None
    ativo: int = 1
    senha_provisoria: bool = False


# --------------------------------------------------------------------------- #
# Categorias
# --------------------------------------------------------------------------- #
class SubcategoriaResposta(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    nome: str
    ativo: bool


class CategoriaResposta(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    nome: str
    ativo: bool
    subcategorias: list[SubcategoriaResposta] = []


class CategoriaCriar(BaseModel):
    nome: str

    @field_validator("nome")
    @classmethod
    def v(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Nome de categoria muito curto.")
        return _sanitizar(v)


class SubcategoriaCriar(BaseModel):
    nome: str
    categoria_id: int

    @field_validator("nome")
    @classmethod
    def v(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Nome de subcategoria muito curto.")
        return _sanitizar(v)


# --------------------------------------------------------------------------- #
# Chamados
# --------------------------------------------------------------------------- #
class ChamadoCriar(BaseModel):
    titulo: str
    descricao: str
    # Campos operacionais opcionais (item 1).
    categoria_id: Optional[int] = None
    subcategoria_id: Optional[int] = None
    sistema_afetado: Optional[str] = None
    modulo_tela: Optional[str] = None
    impacto_negocio: Optional[ImpactoNegocio] = None
    urgencia_solicitante: Optional[int] = Field(default=None, ge=1, le=5)
    unidade_setor: Optional[str] = None
    contato_retorno: Optional[str] = None
    indisponibilidade_inicio: Optional[datetime] = None
    indisponibilidade_fim: Optional[datetime] = None
    # Abertura em nome de terceiro (analista no atendimento telefônico).
    solicitante_id: Optional[int] = None

    @field_validator("titulo")
    @classmethod
    def validar_titulo(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 3:
            raise ValueError("O título deve ter ao menos 3 caracteres.")
        if len(v) > config.MAX_TITULO_LENGTH:
            raise ValueError(f"O título excede {config.MAX_TITULO_LENGTH} caracteres.")
        return _sanitizar(v)

    @field_validator("descricao")
    @classmethod
    def validar_descricao(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 20:
            raise ValueError("Descreva o problema com ao menos 20 caracteres.")
        if len(v) > config.MAX_DESCRICAO_LENGTH:
            raise ValueError(f"A descrição excede {config.MAX_DESCRICAO_LENGTH} caracteres.")
        return _sanitizar(v)

    @field_validator("sistema_afetado", "modulo_tela", "unidade_setor", "contato_retorno")
    @classmethod
    def san_opcionais(cls, v):
        return _sanitizar_opcional(v)


class ChamadoResponder(BaseModel):
    resposta: str

    @field_validator("resposta")
    @classmethod
    def validar_resposta(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("A resposta não pode ser vazia.")
        if len(v) > config.MAX_RESPOSTA_LENGTH:
            raise ValueError("Resposta muito longa.")
        return _sanitizar(v)


class ChamadoAlterarStatus(BaseModel):
    status: StatusChamado
    # Optimistic locking: o cliente envia a versão que viu; se mudou, rejeita.
    versao_linha: Optional[int] = None


class CancelarChamado(BaseModel):
    """Cancelamento por dono ou superior — justificativa obrigatória."""
    motivo: str

    @field_validator("motivo")
    @classmethod
    def validar_motivo(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 5:
            raise ValueError("Informe um motivo com ao menos 5 caracteres.")
        if len(v) > config.MAX_COMENTARIO_LENGTH:
            raise ValueError("Motivo muito longo.")
        return _sanitizar(v)


class ChamadoAtualizarClassificacao(BaseModel):
    """Admin ajusta a triagem (incl. correção da sugestão da IA)."""
    categoria_id: Optional[int] = None
    subcategoria_id: Optional[int] = None
    gravidade: Optional[Gravidade] = None
    prioridade: Optional[int] = Field(default=None, ge=1, le=5)
    impacto_negocio: Optional[ImpactoNegocio] = None
    atribuido_a_id: Optional[int] = None
    versao_linha: Optional[int] = None


class ChamadoEncerrar(BaseModel):
    """Campos de encerramento (causa raiz, solução, prevenção)."""
    causa_raiz: Optional[str] = None
    solucao_aplicada: Optional[str] = None
    acao_preventiva: Optional[str] = None

    @field_validator("causa_raiz", "solucao_aplicada", "acao_preventiva")
    @classmethod
    def san(cls, v):
        return _sanitizar_opcional(v)


# --- Comentários (timeline) ---
class ComentarioCriar(BaseModel):
    corpo: str
    interno: bool = False

    @field_validator("corpo")
    @classmethod
    def v(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("O comentário não pode ser vazio.")
        if len(v) > config.MAX_COMENTARIO_LENGTH:
            raise ValueError("Comentário muito longo.")
        return _sanitizar(v)


class ComentarioResposta(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    corpo: str
    interno: bool
    criado_em: datetime
    autor: SupervisorResumo


# --- Avaliação (CSAT) ---
class AvaliacaoCriar(BaseModel):
    nota: int = Field(ge=1, le=5)
    comentario: Optional[str] = None

    @field_validator("comentario")
    @classmethod
    def san(cls, v):
        return _sanitizar_opcional(v)


class AvaliacaoResposta(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    nota: int
    comentario: Optional[str]
    criado_em: datetime


# --- Anexos ---
class AnexoResposta(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    nome_original: str
    tipo_mime: Optional[str]
    tamanho_bytes: Optional[int]
    criado_em: datetime


class AutorResumo(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    nome: str
    matricula: str


# --- Respostas de chamado ---
class ChamadoResposta(BaseModel):
    """Resposta enxuta (listagens). Mantém compat com o front atual."""
    model_config = ConfigDict(from_attributes=True)
    id: int
    numero_protocolo: Optional[str] = None
    titulo: str
    descricao: str
    status: StatusChamado
    gravidade: Optional[Gravidade]
    prioridade: Optional[int]
    qualidade_descritiva: Optional[QualidadeDescritiva]
    impacto_negocio: Optional[ImpactoNegocio] = None
    sistema_afetado: Optional[str] = None
    resposta_suporte: Optional[str] = None  # compat (último comentário público)
    criado_em: datetime
    atualizado_em: datetime
    resolvido_em: Optional[datetime]
    versao_linha: int = 1
    autor: AutorResumo
    atribuido_a: Optional[AutorResumo] = None
    # Campos derivados (preenchidos na rota, não vêm do ORM).
    sla_prazo: Optional[datetime] = None
    sla_status: Optional[str] = None


class ChamadoDetalhe(ChamadoResposta):
    """Resposta completa (modal de atendimento)."""
    categoria_nome: Optional[str] = None
    subcategoria_nome: Optional[str] = None
    modulo_tela: Optional[str] = None
    unidade_setor: Optional[str] = None
    contato_retorno: Optional[str] = None
    urgencia_solicitante: Optional[int] = None
    indisponibilidade_inicio: Optional[datetime] = None
    indisponibilidade_fim: Optional[datetime] = None
    analise_ia_versao: Optional[str] = None
    ia_confianca: Optional[float] = None
    ia_justificativa: Optional[str] = None
    ia_gravidade_sugerida: Optional[Gravidade] = None
    categoria_sugerida: Optional[str] = None
    causa_raiz: Optional[str] = None
    solucao_aplicada: Optional[str] = None
    acao_preventiva: Optional[str] = None
    comentarios: list[ComentarioResposta] = []
    anexos: list[AnexoResposta] = []
    avaliacao: Optional[AvaliacaoResposta] = None


# --------------------------------------------------------------------------- #
# Base de conhecimento (KB)
# --------------------------------------------------------------------------- #
class ArtigoCriar(BaseModel):
    titulo: str
    conteudo: str
    chamado_origem_id: Optional[int] = None

    @field_validator("titulo")
    @classmethod
    def vt(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 4:
            raise ValueError("Título muito curto.")
        return _sanitizar(v)

    @field_validator("conteudo")
    @classmethod
    def vc(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 10:
            raise ValueError("Conteúdo muito curto.")
        return _sanitizar(v)


class ArtigoResposta(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    titulo: str
    conteudo: str
    chamado_origem_id: Optional[int] = None
    criado_em: datetime
