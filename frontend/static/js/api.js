/* =========================================================================
   api.js — Camada única de comunicação com o back-end.
   Centraliza: token, montagem de requisições, tratamento de erros e
   redirecionamento em caso de sessão expirada.
   ========================================================================= */

const API = (() => {
    const CHAVE_TOKEN = 'helpdesk_token';
    const CHAVE_USUARIO = 'helpdesk_usuario';

    function salvarSessao(token, id, nome, nivel, papel, senhaProvisoria, org) {
        // sessionStorage: a sessão expira ao fechar o navegador (mais seguro
        // que localStorage para um ambiente compartilhado).
        sessionStorage.setItem(CHAVE_TOKEN, token);
        sessionStorage.setItem(
            CHAVE_USUARIO,
            JSON.stringify({ id, nome, nivel, papel, org: org || 'bradesco_bbi',
                             senhaProvisoria: !!senhaProvisoria })
        );
    }

    function marcarSenhaTrocada() {
        const u = obterUsuario();
        if (u) { u.senhaProvisoria = false; sessionStorage.setItem(CHAVE_USUARIO, JSON.stringify(u)); }
    }

    function obterToken() { return sessionStorage.getItem(CHAVE_TOKEN); }
    function obterUsuario() {
        const u = sessionStorage.getItem(CHAVE_USUARIO);
        return u ? JSON.parse(u) : null;
    }
    function limparSessao() {
        sessionStorage.removeItem(CHAVE_TOKEN);
        sessionStorage.removeItem(CHAVE_USUARIO);
    }
    function sair() { limparSessao(); window.location.href = '/'; }

    async function requisitar(caminho, opcoes = {}) {
        const cabecalhos = { 'Content-Type': 'application/json', ...(opcoes.headers || {}) };
        const token = obterToken();
        if (token) cabecalhos['Authorization'] = `Bearer ${token}`;

        let resposta;
        try {
            resposta = await fetch(caminho, { ...opcoes, headers: cabecalhos });
        } catch (e) {
            throw new Error('Falha de conexão com o servidor.');
        }

        if (resposta.status === 401 && token) {
            limparSessao();
            window.location.href = '/';
            throw new Error('Sessão expirada.');
        }

        let corpo = null;
        const tipo = resposta.headers.get('content-type') || '';
        if (tipo.includes('application/json')) corpo = await resposta.json();

        if (!resposta.ok) {
            const msg = extrairMensagemErro(corpo) || `Erro ${resposta.status}.`;
            const err = new Error(msg);
            err.status = resposta.status;
            throw err;
        }
        return corpo;
    }

    // Upload de anexo (multipart/form-data — não usa o helper JSON).
    async function enviarAnexo(chamadoId, file) {
        const fd = new FormData();
        fd.append('arquivo', file);
        const token = obterToken();
        let r;
        try {
            r = await fetch(`/api/chamados/${chamadoId}/anexos`, {
                method: 'POST',
                headers: token ? { 'Authorization': `Bearer ${token}` } : {},
                body: fd,
            });
        } catch (e) { throw new Error('Falha de conexão ao enviar o arquivo.'); }
        if (r.status === 401 && token) { limparSessao(); window.location.href = '/'; throw new Error('Sessão expirada.'); }
        const corpo = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
        if (!r.ok) throw new Error(extrairMensagemErro(corpo) || `Erro ${r.status}.`);
        return corpo;
    }

    // Download de anexo (retorna Blob — requer header de auth, por isso fetch).
    async function baixarAnexo(chamadoId, anexoId) {
        const token = obterToken();
        const r = await fetch(`/api/chamados/${chamadoId}/anexos/${anexoId}`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        if (!r.ok) throw new Error(`Não foi possível baixar o anexo (${r.status}).`);
        return await r.blob();
    }

    function extrairMensagemErro(corpo) {
        if (!corpo) return null;
        const d = corpo.detail;
        if (typeof d === 'string') return d;
        if (Array.isArray(d) && d.length) return d.map(e => e.msg).join(' ');
        return null;
    }

    // Download de blob autenticado (CSV) — fetch para enviar o header de auth.
    async function baixarBlob(caminho) {
        const token = obterToken();
        const r = await fetch(caminho, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        if (!r.ok) throw new Error(`Falha ao exportar (${r.status}).`);
        return await r.blob();
    }

    return {
        salvarSessao, marcarSenhaTrocada, obterToken, obterUsuario, limparSessao, sair,

        login: (matricula, senha) =>
            requisitar('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ matricula, senha }),
            }),

        registrar: (dados) =>
            requisitar('/api/auth/registrar', {
                method: 'POST', body: JSON.stringify(dados),
            }),

        trocarSenha: (senha_atual, nova_senha) =>
            requisitar('/api/auth/trocar-senha', {
                method: 'POST', body: JSON.stringify({ senha_atual, nova_senha }),
            }),
        me: () => requisitar('/api/auth/me'),
        atualizarPerfil: (dados) =>
            requisitar('/api/auth/perfil', { method: 'PUT', body: JSON.stringify(dados) }),

        // --- Notificações (sininho) ---
        notificacoes: () => requisitar('/api/notificacoes'),
        notifContagem: () => requisitar('/api/notificacoes/contagem'),
        notifLida: (id) => requisitar(`/api/notificacoes/${id}/lida`, { method: 'PUT' }),
        notifTodasLidas: () => requisitar('/api/notificacoes/lidas', { method: 'PUT' }),
        notifApagar: (id) => requisitar(`/api/notificacoes/${id}`, { method: 'DELETE' }),
        notifApagarTodas: () => requisitar('/api/notificacoes', { method: 'DELETE' }),

        // --- Solicitante ---
        categoriasAbertura: () => requisitar('/api/chamados/categorias'),
        templatesAbertura: () => requisitar('/api/chamados/templates'),
        deflexao: (titulo, descricao) =>
            requisitar('/api/chamados/deflexao', {
                method: 'POST', body: JSON.stringify({ titulo, descricao }),
            }),
        deflexaoAproveitada: () =>
            requisitar('/api/chamados/deflexao/aproveitada', { method: 'POST' }),
        meusChamados: () => requisitar('/api/chamados'),
        minhaEquipe: () => requisitar('/api/chamados/equipe'),
        cancelarChamado: (id, motivo) =>
            requisitar(`/api/chamados/${id}/cancelar`, {
                method: 'POST', body: JSON.stringify({ motivo }),
            }),
        detalheChamado: (id) => requisitar(`/api/chamados/${id}`),
        abrirChamado: (dados) =>
            requisitar('/api/chamados', { method: 'POST', body: JSON.stringify(dados) }),
        comentar: (id, corpo) =>
            requisitar(`/api/chamados/${id}/comentarios`, {
                method: 'POST', body: JSON.stringify({ corpo, interno: false }),
            }),
        avaliar: (id, nota, comentario) =>
            requisitar(`/api/chamados/${id}/avaliacao`, {
                method: 'POST', body: JSON.stringify({ nota, comentario }),
            }),
        reabrir: (id) =>
            requisitar(`/api/chamados/${id}/reabrir`, { method: 'POST' }),
        enviarAnexo, baixarAnexo,

        // --- Equipe / admin ---
        todosChamados: (filtros = {}) => {
            const p = new URLSearchParams();
            ['status', 'gravidade', 'categoria', 'busca', 'sla', 'atribuido', 'tag', 'de', 'ate', 'limite', 'offset'].forEach(k => {
                if (filtros[k] !== undefined && filtros[k] !== '') p.set(k, filtros[k]);
            });
            const qs = p.toString();
            return requisitar('/api/admin/chamados' + (qs ? `?${qs}` : ''));
        },
        acaoMassa: (ids, acao, valor, motivo) =>
            requisitar('/api/admin/chamados/acao-massa', {
                method: 'POST', body: JSON.stringify({ ids, acao, valor, motivo }),
            }),

        // --- Base de conhecimento ---
        kbListar: (busca) => requisitar('/api/kb' + (busca ? `?busca=${encodeURIComponent(busca)}` : '')),
        kbDetalhe: (id) => requisitar(`/api/kb/${id}`),
        kbCriar: (titulo, conteudo) =>
            requisitar('/api/kb', { method: 'POST', body: JSON.stringify({ titulo, conteudo }) }),
        kbAtualizar: (id, dados) =>
            requisitar(`/api/kb/${id}`, { method: 'PUT', body: JSON.stringify(dados) }),
        kbExcluir: (id) => requisitar(`/api/kb/${id}`, { method: 'DELETE' }),
        kbVotar: (id, util) =>
            requisitar(`/api/kb/${id}/voto`, { method: 'POST', body: JSON.stringify({ util }) }),

        // --- Templates / Tags / Merge ---
        templatesAdmin: () => requisitar('/api/admin/templates'),
        templateCriar: (dados) => requisitar('/api/admin/templates', { method: 'POST', body: JSON.stringify(dados) }),
        templateAtualizar: (id, dados) => requisitar(`/api/admin/templates/${id}`, { method: 'PUT', body: JSON.stringify(dados) }),
        templateExcluir: (id) => requisitar(`/api/admin/templates/${id}`, { method: 'DELETE' }),
        tagsLista: () => requisitar('/api/admin/tags'),
        definirTags: (id, tags) => requisitar(`/api/admin/chamados/${id}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) }),
        mesclarChamado: (id, destino_id) => requisitar(`/api/admin/chamados/${id}/mesclar`, { method: 'POST', body: JSON.stringify({ destino_id }) }),

        // --- Config SLA / feriados ---
        configSla: () => requisitar('/api/admin/config/sla'),
        salvarConfigSla: (itens) => requisitar('/api/admin/config/sla', { method: 'PUT', body: JSON.stringify({ itens }) }),
        adicionarFeriado: (data, descricao) => requisitar('/api/admin/config/feriados', { method: 'POST', body: JSON.stringify({ data, descricao }) }),
        removerFeriado: (data) => requisitar(`/api/admin/config/feriados/${data}`, { method: 'DELETE' }),
        sincronizarFeriados: (ano) => requisitar('/api/admin/config/feriados/sincronizar' + (ano ? `?ano=${ano}` : ''), { method: 'POST' }),
        calendarioEventos: (ano, mes) => requisitar(`/api/chamados/calendario?ano=${ano}&mes=${mes}`),

        similares: (id) => requisitar(`/api/admin/chamados/${id}/similares`),
        promoverArtigo: (id, titulo, conteudo) =>
            requisitar(`/api/admin/chamados/${id}/promover-artigo`, {
                method: 'POST', body: JSON.stringify({ titulo, conteudo }),
            }),
        buscarKb: (busca) =>
            requisitar('/api/admin/kb' + (busca ? `?busca=${encodeURIComponent(busca)}` : '')),
        baixarCsv: () => baixarBlob('/api/admin/exportacao/chamados.csv'),
        detalheAdmin: (id) => requisitar(`/api/admin/chamados/${id}`),
        transicoes: (id) => requisitar(`/api/admin/chamados/${id}/transicoes`),
        responderChamado: (id, resposta) =>
            requisitar(`/api/admin/chamados/${id}/responder`, {
                method: 'PUT', body: JSON.stringify({ resposta }),
            }),
        comentarAdmin: (id, corpo, interno) =>
            requisitar(`/api/admin/chamados/${id}/comentarios`, {
                method: 'POST', body: JSON.stringify({ corpo, interno }),
            }),
        alterarStatus: (id, status, versao_linha) =>
            requisitar(`/api/admin/chamados/${id}/status`, {
                method: 'PUT', body: JSON.stringify({ status, versao_linha }),
            }),
        atualizarClassificacao: (id, dados) =>
            requisitar(`/api/admin/chamados/${id}/classificacao`, {
                method: 'PUT', body: JSON.stringify(dados),
            }),
        encerramento: (id, dados) =>
            requisitar(`/api/admin/chamados/${id}/encerramento`, {
                method: 'PUT', body: JSON.stringify(dados),
            }),
        dashboard: () => requisitar('/api/admin/dashboard'),
        auditoria: (entidadeId) =>
            requisitar('/api/admin/auditoria' +
                (entidadeId ? `?entidade_id=${entidadeId}` : '')),

        // --- Taxonomia ---
        categorias: () => requisitar('/api/admin/categorias'),
        criarCategoria: (nome) =>
            requisitar('/api/admin/categorias', {
                method: 'POST', body: JSON.stringify({ nome }),
            }),
        criarSubcategoria: (nome, categoria_id) =>
            requisitar('/api/admin/subcategorias', {
                method: 'POST', body: JSON.stringify({ nome, categoria_id }),
            }),

        resetDb: (matricula, senha) =>
            requisitar('/api/admin/reset-db', {
                method: 'POST', body: JSON.stringify({ matricula, senha }),
            }),
        limparDados: (matricula, senha) =>
            requisitar('/api/admin/limpar-dados', {
                method: 'POST', body: JSON.stringify({ matricula, senha }),
            }),

        // --- Usuários ---
        usuarios: () => requisitar('/api/admin/usuarios'),
        criarUsuario: (dados) =>
            requisitar('/api/admin/usuarios', { method: 'POST', body: JSON.stringify(dados) }),
        atualizarUsuario: (id, dados) =>
            requisitar(`/api/admin/usuarios/${id}`, { method: 'PUT', body: JSON.stringify(dados) }),
        excluirUsuario: (id) =>
            requisitar(`/api/admin/usuarios/${id}`, { method: 'DELETE' }),
        organograma: () => requisitar('/api/admin/usuarios/organograma'),
    };
})();
