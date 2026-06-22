# Helpdesk Corporativo

Sistema interno de abertura e gestão de chamados para rede local bancária, com
triagem automática por IA (plug and play), hierarquia de papéis, SLA em horário
comercial, trilha de auditoria e interface com tema claro/escuro.

## Stack

| Camada        | Tecnologia                                    |
|---------------|-----------------------------------------------|
| Front-end     | HTML + CSS + JavaScript puro (Vanilla JS)     |
| Gráficos      | Chart.js                                      |
| Back-end      | Python + FastAPI (API REST)                   |
| ORM / Banco   | SQLAlchemy + SQLite (WAL)                      |
| Autenticação  | JWT (com versão/revogação) + bcrypt           |

## Estrutura do projeto

```
helpdesk/
├── backend/
│   ├── main.py             # Monta a app, registra rotas, logging, serve o front
│   ├── config.py           # Configurações: segredos, SLA, rate limit, uploads
│   ├── database.py         # Engine/sessão SQLAlchemy + PRAGMAs do SQLite (WAL)
│   ├── models.py           # Tabelas e enums (Usuario, Chamado, Comentario, ...)
│   ├── schemas.py          # Validação e sanitização (Pydantic)
│   ├── auth.py             # Hash, JWT, papéis, escopo hierárquico, brute force
│   ├── ia.py               # >>> MÓDULO DE IA (mock plug and play) + PII mask <<<
│   ├── sla.py              # Cálculo de SLA em horário comercial + aging
│   ├── estado.py           # Máquina de estados do chamado (transições válidas)
│   ├── notificacoes.py     # Camada de notificação plugável (log/Teams/Slack)
│   ├── auditoria.py        # Helper da trilha de auditoria
│   ├── protocolo.py        # Geração de protocolo (contador atômico, sem corrida)
│   ├── serializar.py       # ORM -> schemas de resposta (com campos derivados)
│   ├── rotas_auth.py       # /api/auth/*      (login, auto-cadastro, me)
│   ├── rotas_chamados.py   # /api/chamados/*  (usuário: abrir, equipe, cancelar, anexos)
│   ├── rotas_admin.py      # /api/admin/*     (admin: gestão, dashboard, auditoria, reset)
│   ├── rotas_usuarios.py   # /api/admin/usuarios/* (gestão de usuários/hierarquia)
│   ├── seed.py             # Cria taxonomia, usuários e chamados de exemplo
│   └── requirements.txt
└── frontend/
    ├── templates/
    │   ├── index.html      # Login + solicitação de cadastro
    │   └── app.html        # Aplicação logada
    └── static/
        ├── css/estilo.css  # Tokens de tema (#800000) + tema claro/escuro
        └── js/
            ├── tema.js     # Gerencia tema claro/escuro (persistente)
            ├── api.js      # Camada de comunicação com a API
            ├── login.js    # Login e auto-cadastro
            └── app.js      # Controlador principal (tabelas, modais, gráficos)
```

## Como executar

```bash
cd backend

# 1. Instalar dependências (idealmente em um virtualenv)
pip install -r requirements.txt

# 2. Definir a chave secreta (OBRIGATÓRIO em produção)
export HELPDESK_SECRET_KEY="uma-chave-longa-e-aleatoria-aqui"

# 3. Popular o banco com dados de exemplo
python seed.py            # cria o que faltar
python seed.py --reset    # APAGA e recria o schema (use ao evoluir o modelo)

# 4. Subir o servidor
uvicorn main:app --host 0.0.0.0 --port 8000
```

Acesse: **http://localhost:8000** · Documentação da API: **http://localhost:8000/docs**

> **Schema e migrações:** `create_all` cria tabelas novas, mas **não altera**
> tabelas existentes. Ao mudar `models.py` em desenvolvimento, rode
> `python seed.py --reset`. Em produção, versione o schema com **Alembic**
> (use `render_as_batch=True` por causa do `ALTER TABLE` limitado do SQLite).

## Credenciais de teste (geradas pelo seed)

| Papel         | Matrícula      | Senha        |
|---------------|----------------|--------------|
| Administrador | `admin`        | `Admin@1234` |
| Coordenador   | `carla.coord`  | `Senha@1234` |
| Líder         | `lucas.lider`  | `Senha@1234` |
| Analista      | `ana.analista` | `Senha@1234` |
| Colaborador   | `joao.silva`   | `Senha@1234` |
| Colaborador   | `maria.souza`  | `Senha@1234` |

> Em produção, integre a autenticação com o Active Directory / LDAP do banco
> e force troca de senha no primeiro acesso.

## Papéis e escopo de visão (hierarquia)

Cada usuário tem um **papel** e, opcionalmente, um **supervisor** (auto-relação),
formando uma árvore. O acesso se divide em dois grupos:

| Quem | Vê / controla |
|------|----------------|
| **Administrador** | tudo — painel, todos os chamados, usuários e auditoria |
| **Qualquer outro papel** (colaborador, analista, líder, coordenador) | os **próprios** chamados **+ os de toda a cadeia abaixo** dele na árvore (subordinados diretos e indiretos) |

- Quem tem subordinados ganha a aba **"Minha equipe"** (lista a cadeia abaixo com
  contadores de chamados) e um **filtro por solicitante** em "Meus chamados".
- **Cancelamento**: o **dono** pode cancelar o próprio chamado e **qualquer
  superior** na cadeia pode cancelar o de quem está abaixo — sempre com
  **justificativa obrigatória** (vira comentário público + registro de auditoria).
  Não cancela o que já está resolvido/fechado.
- O *papel* (analista, líder, coordenador) serve à exibição e para o admin
  atribuir responsáveis. O **atendimento** da fila (responder, classificar,
  resolver) é **exclusivo do administrador** — os demais apenas veem e cancelam.

Trocar papel, desativar usuário ou redefinir senha **revoga as sessões abertas
imediatamente** (via `token_version` no JWT).

## Funcionalidades

**Usuário (qualquer papel não-admin)**
- **Abrir chamado** com campos ricos (categoria/subcategoria, sistema, módulo/tela,
  impacto, urgência, unidade, contato), **descrição mínima** (gate de qualidade) e
  **anexos** (prints, PDF, logs) — triagem de IA automática na criação.
- **Meus chamados**: os próprios **+ os de toda a equipe abaixo**, com **filtro por
  solicitante**; timeline de comentários (sem ver notas internas), **baixar anexos**,
  **comentar** e **avaliar (CSAT)** os próprios, e **cancelar** (o próprio ou o de um
  subordinado, com justificativa).
- **Minha equipe**: as pessoas abaixo na hierarquia, com contadores; clicar leva
  aos chamados daquela pessoa.
- **Auto-cadastro** pela tela de login: a conta fica **pendente** até a aprovação
  de um administrador.

**Administrador**
- **Painel**: KPIs (abertos, resolvidos, críticos, tempo médio, SLA vencido/risco,
  CSAT) e gráficos de gravidade, status, prioridade, **aging**, **SLA** e
  **workload por responsável**.
- **Gestão de chamados** (atende TODOS): fila filtrável por status, gravidade,
  **SLA** e busca; modal em abas com triagem da IA (gravidade, confiança,
  justificativa), **correção da classificação**, atribuição de responsável,
  transição de status (máquina de estados), resposta pública, **nota interna**,
  download de anexos e **encerramento** (causa raiz, solução, ação preventiva).
- **Gestão de usuários**: criar/editar, ativar/desativar, **aprovar** cadastros
  pendentes, definir papel e supervisor.
- **Trilha de auditoria**: quem fez o quê, quando e de onde.
- **Reset do banco**: botão protegido por re-confirmação de matrícula + senha.

## A integração de IA (Plug and Play)

Toda a lógica de análise está isolada em **`backend/ia.py`**. Hoje roda um
**mock** (`AnalisadorMock`) por heurísticas de texto. Contrato de saída estável:

```json
{
  "gravidade": "Baixa | Média | Alta | Crítica",
  "prioridade": 1,
  "qualidade_descritiva": "boa | ruim",
  "categoria_sugerida": "Acesso | Hardware | ... | null",
  "confianca": 0.9,
  "justificativa": "texto explicando a classificação",
  "versao_modelo": "mock-2.0.0"
}
```

Antes de qualquer texto chegar ao analisador, ele passa por `mascarar_pii()`,
que neutraliza **CPF, cartão, e-mail e telefone** (LGPD) — essencial quando a IA
for um serviço externo.

### Para plugar a IA real

1. Crie uma classe que herde de `AnalisadorIA` e implemente `analisar()`.
2. Troque **uma única linha** em `ia.py`:

```python
# Antes:
analisador_ativo: AnalisadorIA = AnalisadorMock()
# Depois:
from ia_proprietaria import AnalisadorBancoXPTO
analisador_ativo: AnalisadorIA = AnalisadorBancoXPTO(endpoint="...", token="...")
```

O resto do sistema não muda. Se a IA real cair, o chamado é criado mesmo assim,
marcado como `versao_modelo="indisponivel"` e `confianca=0.0` — sinal explícito
de que requer **triagem humana** (em vez de fingir uma classificação).

## Concorrência e robustez (SQLite)

- **WAL mode** + `busy_timeout`: leituras não bloqueiam escritas; aberturas
  concorrentes esperam o lock em vez de falhar (ver `database.py`).
- **Protocolo sem corrida**: `protocolo.py` usa uma linha-contador incrementada
  por `UPDATE` atômico — testado com 40 aberturas simultâneas, 0 duplicados.
- **Optimistic locking**: `versao_linha` no chamado evita sobrescrita simultânea
  (responde **409** se o registro mudou desde que foi carregado).
- **Rate limit** por usuário na abertura de chamado e **bloqueio temporário**
  após tentativas de login falhas (defesa contra brute force).
- **Notificações assíncronas** desacopladas via `notificacoes.py` (canal de log
  hoje, pronto para Teams/Slack por webhook).

## SLA (horário comercial)

O prazo de SLA é calculado em **horas úteis** (jornada e dias úteis
configuráveis em `config.py`), não em horas corridas. O relógio **pausa** quando
o chamado está em "aguardando usuário" (a responsabilidade está com o
solicitante). Cada chamado expõe `sla_status`: `ok`, `em_risco` ou `vencido`.

## Segurança (considerações para ambiente bancário)

- **Senhas** com hash bcrypt — nunca em texto puro.
- **JWT** com expiração curta e **revogação imediata** por `token_version`.
  Token em `sessionStorage` (expira ao fechar o navegador).
- **Sanitização de entrada** (Pydantic + escape de HTML) e **escape na
  renderização** — defesa em profundidade contra XSS.
- **Mascaramento de PII** antes da IA (CPF, cartão, e-mail, telefone).
- **SQL Injection** mitigado pelo SQLAlchemy (parâmetros vinculados).
- **Autorização por papel** e escopo hierárquico de visão.
- **Auto-cadastro** sempre cria colaborador inativo (aprovação obrigatória).
- **Ações destrutivas** (reset do banco) exigem re-confirmação de credenciais e
  ficam registradas na **trilha de auditoria**.
- **Uploads** validados por extensão e tamanho; binário em disco, metadados no
  banco (nome, tipo, tamanho, hash SHA-256).
- **Mensagens de erro genéricas** no login (não revelam se a matrícula existe).
- **Cabeçalhos de segurança** (CSP, X-Frame-Options, X-Content-Type-Options) e
  erros internos sem vazar stacktrace.

## Tema (claro / escuro)

A interface usa tokens CSS com a cor primária **`#800000` (marrom-vinho)** e
suporta **tema claro e escuro** via `data-theme`, com contraste AA. O toggle fica
no topo e a escolha persiste em `localStorage` (respeita a preferência do sistema
na primeira visita).

## Variáveis de ambiente úteis

| Variável                          | Padrão                     | Descrição                          |
|-----------------------------------|----------------------------|------------------------------------|
| `HELPDESK_SECRET_KEY`             | aleatória por boot         | Chave de assinatura do JWT         |
| `HELPDESK_TOKEN_EXPIRE_MINUTES`   | `480`                      | Expiração do token (minutos)       |
| `HELPDESK_DATABASE_URL`           | `sqlite:///./helpdesk.db`  | URL do banco                       |
| `HELPDESK_MAX_LOGIN_ATTEMPTS`     | `5`                        | Tentativas antes do bloqueio       |
| `HELPDESK_MAX_CHAMADOS_MINUTO`    | `10`                       | Rate limit de abertura por usuário |
| `HELPDESK_SLA_HORA_INICIO` / `_FIM` | `8` / `18`               | Janela de horário comercial        |
| `HELPDESK_UPLOAD_DIR`             | `./uploads`                | Pasta de anexos                    |
