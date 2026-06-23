/* =========================================================================
   api.js — Camada única de comunicação com o back-end.
   Centraliza: token, montagem de requisições, tratamento de erros e
   redirecionamento em caso de sessão expirada.
   ========================================================================= */

const API = (() => {
    const CHAVE_TOKEN = 'helpdesk_token';
    const CHAVE_USUARIO = 'helpdesk_usuario';

    function salvarSessao(token, id, nome, nivel, papel, senhaProvisoria) {
        // sessionStorage: a sessão expira ao fechar o navegador (mais seguro
        // que localStorage para um ambiente compartilhado).
        sessionStorage.setItem(CHAVE_TOKEN, token);
        sessionStorage.setItem(
            CHAVE_USUARIO,
            JSON.stringify({ id, nome, nivel, papel, senhaProvisoria: !!senhaProvisoria })
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

        // --- Solicitante ---
        categoriasAbertura: () => requisitar('/api/chamados/categorias'),
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
            ['status', 'gravidade', 'busca', 'sla', 'atribuido', 'limite', 'offset'].forEach(k => {
                if (filtros[k] !== undefined && filtros[k] !== '') p.set(k, filtros[k]);
            });
            const qs = p.toString();
            return requisitar('/api/admin/chamados' + (qs ? `?${qs}` : ''));
        },

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

        // --- Usuários ---
        usuarios: () => requisitar('/api/admin/usuarios'),
        criarUsuario: (dados) =>
            requisitar('/api/admin/usuarios', { method: 'POST', body: JSON.stringify(dados) }),
        atualizarUsuario: (id, dados) =>
            requisitar(`/api/admin/usuarios/${id}`, { method: 'PUT', body: JSON.stringify(dados) }),
        organograma: () => requisitar('/api/admin/usuarios/organograma'),
    };
})();
