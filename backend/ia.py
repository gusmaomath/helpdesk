"""
=============================================================================
MÓDULO DE ANÁLISE DE IA  —  ARQUITETURA PLUG AND PLAY
=============================================================================

Este módulo isola TODA a lógica de análise inteligente dos chamados.

Hoje ele roda um MOCK (simulação determinística baseada em heurísticas
simples de texto). Amanhã, quando a IA proprietária do banco estiver pronta,
basta:

    1. Criar uma nova classe que herde de `AnalisadorIA`.
    2. Implementar o método `analisar(titulo, descricao)`.
    3. Trocar a linha do `analisador_ativo` no final do arquivo.

O RESTO DO SISTEMA NÃO PRECISA SER ALTERADO. Toda a aplicação consome a
função pública `analisar_chamado()`, que sempre devolve o mesmo contrato.

-----------------------------------------------------------------------------
CONTRATO DE SAÍDA (dict) — estável, não muda quando a IA real entrar:
{
    "gravidade":            "Baixa" | "Média" | "Alta" | "Crítica",
    "prioridade":           int (1 a 5),
    "qualidade_descritiva": "boa" | "ruim",
    "categoria_sugerida":   str | None,
    "confianca":            float (0.0 a 1.0),
    "justificativa":        str,
    "versao_modelo":        str
}
-----------------------------------------------------------------------------
PRIVACIDADE (LGPD): antes de QUALQUER texto chegar ao analisador, ele passa
por `mascarar_pii()`, que neutraliza CPF, cartão, e-mail e telefone. Isso é
crítico quando a IA real for um serviço externo.
"""
import re
from abc import ABC, abstractmethod
from typing import Optional, TypedDict


# --------------------------------------------------------------------------- #
# Mascaramento de PII (compliance / LGPD)
# --------------------------------------------------------------------------- #
_RE_CPF = re.compile(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b")
_RE_CARTAO = re.compile(r"\b(?:\d[ -]?){13,16}\b")
_RE_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
_RE_TELEFONE = re.compile(r"\b(?:\(?\d{2}\)?[\s-]?)?\d{4,5}-?\d{4}\b")


def mascarar_pii(texto: str) -> str:
    """
    Substitui dados sensíveis por marcadores antes de enviar à IA.
    A ordem importa: CPF/cartão antes de telefone (evita sobreposição).
    """
    if not texto:
        return texto
    texto = _RE_CPF.sub("[CPF]", texto)
    texto = _RE_CARTAO.sub("[CARTAO]", texto)
    texto = _RE_EMAIL.sub("[EMAIL]", texto)
    texto = _RE_TELEFONE.sub("[TELEFONE]", texto)
    return texto


class ResultadoAnalise(TypedDict):
    """Contrato de retorno da análise. Imutável entre mock e modelo real."""
    gravidade: str
    prioridade: int
    qualidade_descritiva: str
    categoria_sugerida: Optional[str]
    confianca: float
    justificativa: str
    versao_modelo: str


class AnalisadorIA(ABC):
    """
    Interface (contrato) que qualquer analisador — mock ou real — deve cumprir.
    Para plugar a IA real, herde desta classe e implemente `analisar`.
    """

    versao: str = "base"

    @abstractmethod
    def analisar(self, titulo: str, descricao: str) -> ResultadoAnalise:
        ...


class AnalisadorMock(AnalisadorIA):
    """
    Implementação SIMULADA. Não usa nenhum modelo de verdade.

    Aplica heurísticas simples e transparentes sobre o texto. Além de gravidade
    e prioridade, agora produz:
      - categoria_sugerida (palpite de taxonomia)
      - confianca (quão forte foi o sinal encontrado)
      - justificativa (qual termo disparou a classificação)

    É DETERMINÍSTICO: a mesma entrada gera sempre a mesma saída.
    """

    versao = "mock-2.0.0"

    _PALAVRAS_CRITICAS = {
        "fraude", "invasão", "invasao", "vazamento", "indisponível",
        "indisponivel", "fora do ar", "parado", "produção", "producao",
        "transação", "transacao", "pix", "ted", "doc", "core banking",
        "banco de dados caiu", "ransomware", "sequestro", "phishing",
    }
    _PALAVRAS_ALTAS = {
        "erro", "falha", "travando", "lento", "não consigo", "nao consigo",
        "bloqueado", "acesso negado", "senha", "urgente", "crítico", "critico",
        "impacto", "vários usuários", "varios usuarios",
    }
    _PALAVRAS_MEDIAS = {
        "dúvida", "duvida", "configuração", "configuracao", "instalar",
        "atualizar", "solicitação", "solicitacao", "permissão", "permissao",
    }

    # Sinais simples para sugerir categoria (palavra -> categoria).
    _MAPA_CATEGORIA = {
        "Acesso": {"senha", "acesso", "login", "bloqueado", "permissão", "permissao", "vpn"},
        "Hardware": {"mouse", "teclado", "monitor", "impressora", "notebook", "máquina", "maquina"},
        "Infraestrutura": {"rede", "internet", "servidor", "fora do ar", "lento", "vpn"},
        "Sistema": {"erro", "tela", "sistema", "erp", "crm", "aplicativo", "portal"},
        "Dados": {"relatório", "relatorio", "planilha", "banco de dados", "exportar"},
        "IA": {"prompt", "ia", "modelo", "resposta da ia", "integração", "integracao"},
    }

    def analisar(self, titulo: str, descricao: str) -> ResultadoAnalise:
        # Mascara PII ANTES de qualquer processamento (defesa para IA externa).
        titulo_s = mascarar_pii(titulo or "")
        descricao_s = mascarar_pii(descricao or "")
        texto = f"{titulo_s} {descricao_s}".lower()

        gravidade, termo, confianca = self._classificar_gravidade(texto)
        prioridade = self._gravidade_para_prioridade(gravidade)
        qualidade = self._avaliar_qualidade(descricao_s)
        categoria = self._sugerir_categoria(texto)

        if termo:
            justificativa = (
                f"Classificado como '{gravidade}' pelo termo '{termo}'. "
                f"Qualidade da descrição: {qualidade}."
            )
        else:
            justificativa = (
                f"Sem termos de alta criticidade; classificado como '{gravidade}'."
            )

        return ResultadoAnalise(
            gravidade=gravidade,
            prioridade=prioridade,
            qualidade_descritiva=qualidade,
            categoria_sugerida=categoria,
            confianca=confianca,
            justificativa=justificativa,
            versao_modelo=self.versao,
        )

    # ------------------------------------------------------------------ #
    def _classificar_gravidade(self, texto: str):
        for p in self._PALAVRAS_CRITICAS:
            if p in texto:
                return "Crítica", p, 0.9
        for p in self._PALAVRAS_ALTAS:
            if p in texto:
                return "Alta", p, 0.75
        for p in self._PALAVRAS_MEDIAS:
            if p in texto:
                return "Média", p, 0.6
        return "Baixa", None, 0.4

    @staticmethod
    def _gravidade_para_prioridade(gravidade: str) -> int:
        mapa = {"Crítica": 5, "Alta": 4, "Média": 3, "Baixa": 2}
        return mapa.get(gravidade, 1)

    @staticmethod
    def _avaliar_qualidade(descricao: str) -> str:
        n_palavras = len(descricao.strip().split())
        return "boa" if n_palavras >= 12 else "ruim"

    def _sugerir_categoria(self, texto: str) -> Optional[str]:
        melhor, melhor_score = None, 0
        for categoria, termos in self._MAPA_CATEGORIA.items():
            score = sum(1 for t in termos if t in texto)
            if score > melhor_score:
                melhor, melhor_score = categoria, score
        return melhor


# =============================================================================
# PONTO ÚNICO DE TROCA — aqui você liga o modelo real no futuro.
#
# Exemplo futuro:
#     from ia_proprietaria import AnalisadorBancoXPTO
#     analisador_ativo: AnalisadorIA = AnalisadorBancoXPTO(endpoint="...", token="...")
# =============================================================================
analisador_ativo: AnalisadorIA = AnalisadorMock()


def analisar_chamado(titulo: str, descricao: str) -> ResultadoAnalise:
    """
    Função pública consumida pelo resto da aplicação.

    Degradação graciosa: se a análise falhar (ex.: IA real fora do ar), o
    chamado AINDA é criado, mas marcado com versao_modelo="indisponivel" e
    confianca=0.0 — sinal explícito de que precisa de TRIAGEM HUMANA, em vez
    de fingir uma classificação "Baixa" que mascararia um incidente grave.
    """
    try:
        return analisador_ativo.analisar(titulo, descricao)
    except Exception:
        return ResultadoAnalise(
            gravidade="Média",  # neutro: não esconde gravidade nem infla
            prioridade=3,
            qualidade_descritiva="ruim",
            categoria_sugerida=None,
            confianca=0.0,
            justificativa="IA indisponível — requer triagem humana.",
            versao_modelo="indisponivel",
        )
