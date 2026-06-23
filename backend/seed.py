"""
Script de inicialização de dados (seed).

Cria taxonomia, usuários (com hierarquia/papéis) e um volume de chamados com
datas espalhadas — para que os painéis de aging, SLA e CSAT tenham o que mostrar.

Uso:
    python seed.py            # cria o que faltar (idempotente para usuários)
    python seed.py --reset    # APAGA e recria o schema (use ao evoluir o modelo)

ATENÇÃO: senhas abaixo são apenas para DESENVOLVIMENTO. Em produção, integre
com o Active Directory / LDAP ou force troca no primeiro acesso.

Sobre migrações: em produção o schema deve ser versionado com Alembic
(com render_as_batch=True por causa do ALTER TABLE limitado do SQLite). Em dev,
`--reset` é o caminho rápido.
"""
import random
import sys
from datetime import date, timedelta

from app.security.auth import gerar_hash_senha
from app.database import Base, SessionLocal, engine
from app.services.ia import analisar_chamado
from app.config import config
from app.models import (
    Artigo,
    Categoria,
    Chamado,
    Feriado,
    Gravidade,
    ImpactoNegocio,
    NivelAcesso,
    Organizacao,
    Papel,
    ParametroSla,
    QualidadeDescritiva,
    StatusChamado,
    Subcategoria,
    Template,
    Usuario,
    agora_utc,
)
from app.services.protocolo import gerar_protocolo
from app.services.sla import calcular_prazo

TAXONOMIA = {
    "Sistema": ["Erro de resposta", "Tela travando", "Integração"],
    "Infraestrutura": ["Rede", "Servidor", "VPN"],
    "Acesso": ["Senha bloqueada", "Permissão", "Novo acesso"],
    "Dados": ["Relatório", "Exportação", "Inconsistência"],
    "IA": ["Ajuda com prompt", "Erro de resposta", "Integração"],
    "Hardware": ["Mouse/Teclado", "Monitor", "Impressora"],
    "Solicitação": ["Instalação de software", "Equipamento novo", "Outros"],
}

EXEMPLOS = [
    ("Sistema de PIX fora do ar",
     "O sistema de transação PIX está indisponível desde as 9h, impactando "
     "vários usuários da agência central. Urgente.", ImpactoNegocio.CRITICO),
    ("Não consigo acessar meu e-mail",
     "Minha senha do e-mail parece estar bloqueada, acesso negado.", ImpactoNegocio.MEDIO),
    ("Dúvida sobre instalação de software",
     "Preciso instalar o leitor de PDF na minha máquina.", ImpactoNegocio.BAIXO),
    ("Mouse com defeito", "Parou de funcionar.", ImpactoNegocio.BAIXO),
    ("Relatório de fechamento com valores divergentes",
     "O relatório mensal de fechamento está trazendo valores divergentes do "
     "esperado para a filial sul. Preciso de apoio para investigar.", ImpactoNegocio.ALTO),
    ("VPN cai a cada 10 minutos",
     "Desde ontem a VPN derruba a conexão constantemente, atrapalhando o "
     "trabalho remoto de toda a equipe.", ImpactoNegocio.ALTO),
    ("Erro na tela de cadastro do CRM",
     "Ao salvar um novo cliente no CRM aparece um erro e os dados se perdem.", ImpactoNegocio.MEDIO),
    ("Ajuda para escrever um prompt de IA",
     "Gostaria de ajuda para montar um prompt melhor para o assistente interno.", ImpactoNegocio.BAIXO),
]


ARTIGOS = [
    ("PIX fora do ar: o que fazer antes de abrir chamado",
     "1) Confirme no painel de status interno se a indisponibilidade do PIX já é "
     "conhecida. 2) Aguarde alguns minutos — quedas curtas costumam se "
     "restabelecer sozinhas. 3) Se passar de 15 minutos ou afetar transações de "
     "clientes, abra um chamado com gravidade crítica informando agência, horário "
     "de início e quantos usuários afetados."),
    ("Senha do e-mail bloqueada ou acesso negado",
     "Acesse o Portal Interno e clique em 'Esqueci minha senha' para receber o "
     "link de redefinição no e-mail alternativo. Se a conta estiver bloqueada por "
     "tentativas, aguarde 15 minutos e tente novamente. Persistindo, abra um "
     "chamado na categoria Acesso informando sua matrícula."),
    ("VPN cai com frequência",
     "Verifique a estabilidade da sua conexão (Wi-Fi x cabo). Feche e reabra o "
     "cliente de VPN. Se as quedas continuarem, registre os horários aproximados "
     "das desconexões e abra um chamado na categoria Infraestrutura — isso ajuda "
     "a equipe a correlacionar com instabilidades de rede."),
    ("Erro ao salvar cadastro no CRM",
     "Confirme se todos os campos obrigatórios estão preenchidos e se não há "
     "caracteres especiais no nome/razão social. Tente novamente após recarregar "
     "a tela. Se o erro persistir, anote a mensagem exata e a tela onde ocorre e "
     "abra um chamado na categoria Sistema com o print do erro."),
    ("Como solicitar instalação de software",
     "Softwares homologados podem ser instalados pela Central de Software. Para "
     "itens fora do catálogo, abra um chamado na categoria Solicitação informando "
     "o nome do software, a finalidade e a aprovação do seu gestor, se exigida."),
    ("Impressora ou periférico não funciona",
     "Verifique cabos e se o equipamento está ligado. Reinicie o computador. Para "
     "impressoras de rede, confirme se você selecionou a fila correta. Se não "
     "resolver, abra um chamado na categoria Hardware indicando o número de "
     "patrimônio do equipamento."),
]


def _reset():
    print("Apagando e recriando o schema...")
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)


def criar_kb(db, autor):
    if db.query(Artigo).first():
        return
    print("Criando base de conhecimento de exemplo...")
    for titulo, conteudo in ARTIGOS:
        db.add(Artigo(titulo=titulo, conteudo=conteudo, criado_por_id=autor.id))
    db.commit()


def criar_config_sla(db):
    if db.query(ParametroSla).first():
        return
    for prioridade, horas in config.SLA_HORAS_POR_PRIORIDADE.items():
        db.add(ParametroSla(prioridade=prioridade, horas=horas))
    db.commit()


def _domingo_de_pascoa(ano: int) -> date:
    """Data da Páscoa (algoritmo de Meeus/Jones/Butcher) — base dos móveis."""
    a = ano % 19
    b, c = divmod(ano, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mes, dia = divmod(h + l - 7 * m + 114, 31)
    return date(ano, mes, dia + 1)


def feriados_b3(ano: int) -> dict:
    """
    Calendário oficial de feriados da B3 para o ano (sem pregão), incluindo os
    móveis derivados da Páscoa. Consciência Negra entrou como nacional em 2024.
    """
    pascoa = _domingo_de_pascoa(ano)
    feriados = {
        f"{ano}-01-01": "Confraternização Universal",
        f"{ano}-04-21": "Tiradentes",
        f"{ano}-05-01": "Dia do Trabalho",
        f"{ano}-09-07": "Independência do Brasil",
        f"{ano}-10-12": "Nossa Senhora Aparecida",
        f"{ano}-11-02": "Finados",
        f"{ano}-11-15": "Proclamação da República",
        f"{ano}-12-25": "Natal",
        # Véspera de Natal e de Ano-Novo: B3 não opera.
        f"{ano}-12-24": "Véspera de Natal (B3 sem pregão)",
        f"{ano}-12-31": "Véspera de Ano-Novo (B3 sem pregão)",
        # Móveis (dependentes da Páscoa):
        (pascoa - timedelta(days=48)).isoformat(): "Carnaval (segunda)",
        (pascoa - timedelta(days=47)).isoformat(): "Carnaval (terça)",
        (pascoa - timedelta(days=2)).isoformat(): "Sexta-feira Santa",
        (pascoa + timedelta(days=60)).isoformat(): "Corpus Christi",
    }
    if ano >= 2024:
        feriados[f"{ano}-11-20"] = "Consciência Negra"
    return feriados


def criar_feriados_b3(db):
    """Pré-carrega o calendário B3 do ano atual e do próximo (idempotente)."""
    ano = agora_utc().year
    existentes = {f.data for f in db.query(Feriado).all()}
    novos = 0
    for a in (ano, ano + 1):
        for data, descricao in feriados_b3(a).items():
            if data not in existentes:
                db.add(Feriado(data=data, descricao=descricao))
                existentes.add(data)
                novos += 1
    if novos:
        print(f"Carregando {novos} feriados da B3 ({ano}/{ano + 1})...")
        db.commit()


def criar_templates(db, db_cats):
    if db.query(Template).first():
        return
    print("Criando modelos (templates) de chamado...")
    modelos = [
        ("Solicitar acesso a sistema", "Solicitação de acesso",
         "Sistema: \nPerfil/permissão necessária: \nJustificativa/aprovador: ",
         "Acesso", ImpactoNegocio.MEDIO),
        ("Trocar periférico (mouse/teclado)", "Troca de periférico",
         "Equipamento com defeito: \nNº de patrimônio: \nLocal/ramal: ",
         "Hardware", ImpactoNegocio.BAIXO),
        ("Reportar erro em sistema", "Erro no sistema",
         "Sistema/tela: \nMensagem de erro exata: \nPassos para reproduzir: ",
         "Sistema", ImpactoNegocio.ALTO),
    ]
    for nome, titulo, descricao, cat_nome, impacto in modelos:
        db.add(Template(
            nome=nome, titulo=titulo, descricao=descricao,
            categoria_id=db_cats.get(cat_nome), impacto_negocio=impacto,
        ))
    db.commit()


def criar_usuario(db, nome, matricula, senha, nivel, papel, supervisor=None,
                  setor=None, email=None, organizacao=Organizacao.BRADESCO_BBI):
    existente = db.query(Usuario).filter(Usuario.matricula == matricula).first()
    if existente:
        print(f"  - Usuário '{matricula}' já existe, pulando.")
        return existente
    u = Usuario(
        nome=nome, matricula=matricula, senha_hash=gerar_hash_senha(senha),
        nivel_acesso=nivel, papel=papel, organizacao=organizacao,
        supervisor_id=supervisor.id if supervisor else None,
        unidade_setor=setor, email=email,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    print(f"  + Usuário: {matricula} ({papel.value})")
    return u


def criar_taxonomia(db):
    if db.query(Categoria).first():
        return
    print("Criando taxonomia (categorias/subcategorias)...")
    for nome_cat, subs in TAXONOMIA.items():
        cat = Categoria(nome=nome_cat)
        db.add(cat)
        db.flush()
        for s in subs:
            db.add(Subcategoria(nome=s, categoria_id=cat.id))
    db.commit()


def criar_chamado(db, titulo, descricao, autor, impacto, dias_atras, status, db_cats,
                  atribuido=None):
    # Chamados que saíram de "aberto" já têm um responsável (workload real).
    atribuido_id = atribuido.id if (atribuido and status != StatusChamado.ABERTO) else None
    chamado = Chamado(
        titulo=titulo, descricao=descricao, autor_id=autor.id, aberto_por_id=autor.id,
        impacto_negocio=impacto, unidade_setor=autor.unidade_setor,
        contato_retorno=autor.email, numero_protocolo=gerar_protocolo(db),
        status=status, atribuido_a_id=atribuido_id,
    )
    analise = analisar_chamado(titulo, descricao)
    chamado.gravidade = Gravidade(analise["gravidade"])
    chamado.prioridade = analise["prioridade"]
    chamado.qualidade_descritiva = QualidadeDescritiva(analise["qualidade_descritiva"])
    chamado.analise_ia_versao = analise["versao_modelo"]
    chamado.ia_confianca = analise["confianca"]
    chamado.ia_justificativa = analise["justificativa"]
    chamado.ia_gravidade_sugerida = Gravidade(analise["gravidade"])
    chamado.categoria_sugerida = analise["categoria_sugerida"]

    # Liga a categoria sugerida, se existir na taxonomia.
    if analise["categoria_sugerida"] in db_cats:
        chamado.categoria_id = db_cats[analise["categoria_sugerida"]]

    criado = agora_utc() - timedelta(days=dias_atras, hours=random.randint(0, 8))
    chamado.criado_em = criado
    chamado.sla_prazo = calcular_prazo(criado, chamado.prioridade)
    if status in (StatusChamado.RESOLVIDO, StatusChamado.FECHADO):
        chamado.resolvido_em = criado + timedelta(hours=random.randint(2, 36))
    db.add(chamado)
    db.commit()


def executar_seed(reset: bool = False) -> None:
    """
    Popula o banco. Se `reset=True`, APAGA e recria o schema antes.
    Função reutilizável: chamada pela CLI e pelo endpoint admin de reset.
    """
    if reset:
        _reset()
    else:
        Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        criar_taxonomia(db)
        db_cats = {c.nome: c.id for c in db.query(Categoria).all()}

        print("Criando usuários de exemplo...")
        # APENAS o admin tem nível ADMINISTRADOR (vê tudo). Os demais são
        # usuários comuns; o `papel` serve à hierarquia e à exibição, e cada um
        # enxerga os próprios chamados + os dos subordinados diretos.
        admin = criar_usuario(
            db, "Administrador do Suporte", "admin", "Admin@1234",
            NivelAcesso.ADMINISTRADOR, Papel.ADMINISTRADOR, setor="TI",
            email="admin@empresa.com",
        )
        coord = criar_usuario(
            db, "Carla Coordenadora", "carla.coord", "Senha@1234",
            NivelAcesso.USUARIO, Papel.COORDENADOR, supervisor=admin,
            setor="TI", email="carla@empresa.com",
        )
        lider = criar_usuario(
            db, "Lucas Líder", "lucas.lider", "Senha@1234",
            NivelAcesso.USUARIO, Papel.LIDER, supervisor=coord,
            setor="Suporte N1", email="lucas@empresa.com",
        )
        analista = criar_usuario(
            db, "Ana Analista", "ana.analista", "Senha@1234",
            NivelAcesso.USUARIO, Papel.ANALISTA, supervisor=lider,
            setor="Suporte N1", email="ana@empresa.com",
        )
        joao = criar_usuario(
            db, "João da Silva", "joao.silva", "Senha@1234",
            NivelAcesso.USUARIO, Papel.COLABORADOR, supervisor=lider,
            setor="Agência Central", email="joao@empresa.com",
        )

        # --- Equipe Ágora Investimentos (interface verde-petróleo) ---
        # Sub-árvore própria, para testar todos os papéis/visões na cor Ágora.
        bianca = criar_usuario(
            db, "Bianca Líder (Ágora)", "bianca.agora", "Senha@1234",
            NivelAcesso.USUARIO, Papel.LIDER, supervisor=coord,
            setor="Ágora — Mesa", email="bianca@agorainvest.com.br",
            organizacao=Organizacao.AGORA,
        )
        maria = criar_usuario(
            db, "Maria Souza", "maria.souza", "Senha@1234",
            NivelAcesso.USUARIO, Papel.COLABORADOR, supervisor=bianca,
            setor="Ágora — Filial Sul", email="maria@agorainvest.com.br",
            organizacao=Organizacao.AGORA,
        )
        pedro = criar_usuario(
            db, "Pedro Ágora", "pedro.agora", "Senha@1234",
            NivelAcesso.USUARIO, Papel.COLABORADOR, supervisor=bianca,
            setor="Ágora — Atendimento", email="pedro@agorainvest.com.br",
            organizacao=Organizacao.AGORA,
        )

        if not db.query(Chamado).first():
            print("Criando chamados de exemplo (com datas espalhadas)...")
            # Bradesco BBI (joao) + Ágora (maria, pedro): há chamados nas duas marcas.
            solicitantes = [joao, maria, pedro]
            estados = [
                StatusChamado.ABERTO, StatusChamado.EM_ANDAMENTO,
                StatusChamado.AGUARDANDO_USUARIO, StatusChamado.RESOLVIDO,
                StatusChamado.FECHADO,
            ]
            for i, (titulo, desc, impacto) in enumerate(EXEMPLOS):
                criar_chamado(
                    db, titulo, desc, random.choice(solicitantes), impacto,
                    dias_atras=random.randint(0, 6),
                    status=estados[i % len(estados)], db_cats=db_cats,
                    atribuido=analista,
                )
            # Volume extra para os gráficos.
            for i in range(20):
                titulo, desc, impacto = random.choice(EXEMPLOS)
                criar_chamado(
                    db, f"{titulo} ({i+1})", desc, random.choice(solicitantes),
                    impacto, dias_atras=random.randint(0, 14),
                    status=random.choice(estados), db_cats=db_cats,
                    atribuido=random.choice([analista, lider]),
                )
        else:
            print("  - Já existem chamados, pulando criação.")

        criar_kb(db, admin)
        criar_config_sla(db)
        criar_feriados_b3(db)
        criar_templates(db, db_cats)

        print("\nSeed concluído com sucesso!")
        print("-" * 64)
        print("Credenciais de teste:                            | Organização")
        print("  ADMIN       -> admin        | Admin@1234        | Bradesco BBI")
        print("  COORDENADOR -> carla.coord  | Senha@1234        | Bradesco BBI")
        print("  LÍDER       -> lucas.lider  | Senha@1234        | Bradesco BBI")
        print("  ANALISTA    -> ana.analista | Senha@1234        | Bradesco BBI")
        print("  USUÁRIO     -> joao.silva   | Senha@1234        | Bradesco BBI")
        print("  LÍDER       -> bianca.agora | Senha@1234        | Ágora (verde)")
        print("  USUÁRIO     -> maria.souza  | Senha@1234        | Ágora (verde)")
        print("  USUÁRIO     -> pedro.agora  | Senha@1234        | Ágora (verde)")
        print("-" * 64)
    finally:
        db.close()


def main():
    executar_seed(reset="--reset" in sys.argv)


if __name__ == "__main__":
    main()
