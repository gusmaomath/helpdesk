/* =========================================================================
   app.js — Controlador principal da interface logada.
   Decide o que mostrar conforme o PAPEL, renderiza tabelas, gerencia modais
   de atendimento/usuário e desenha os gráficos do painel.
   ========================================================================= */

(function () {
    'use strict';

    // --- Guarda de sessão ---
    const usuario = API.obterUsuario();
    if (!API.obterToken() || !usuario) {
        window.location.href = '/';
        return;
    }

    const RANK = { colaborador: 1, analista: 2, lider: 3, coordenador: 4, administrador: 5 };
    const papel = usuario.papel || (usuario.nivel === 'administrador' ? 'administrador' : 'colaborador');
    // Apenas o ADMIN vê o painel completo. Os demais (qualquer papel) veem só
    // "Abrir chamado" e "Meus chamados" (próprios + subordinados diretos).
    const ehAdmin = usuario.nivel === 'administrador';

    // Estado: sub-aba "Minha fila" da gestão (filtra atribuídos ao usuário logado).
    let gestaoMinhaFila = false;
    // Estado: termo da busca global aplicado em "Meus chamados" (não-admin).
    let buscaMeusTexto = '';
    // Estado: modelo (template) escolhido na abertura — guia os campos modulares.
    let templateAtivo = null;

    // --- Tema (toggle no topo) ---
    if (window.Tema) window.Tema.conectarBotao(document.getElementById('btn-tema'));

    // --- Utilidades ---------------------------------------------------- //
    function esc(t) {
        if (t === null || t === undefined) return '';
        const d = document.createElement('div'); d.textContent = String(t); return d.innerHTML;
    }
    function formatarData(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleString('pt-BR', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    }
    const ROTULO_STATUS = {
        aberto: 'Aberto', em_andamento: 'Em andamento', aguardando_usuario: 'Aguardando usuário',
        resolvido: 'Resolvido', fechado: 'Fechado', reaberto: 'Reaberto', cancelado: 'Cancelado',
    };
    const ROTULO_IMPACTO = { baixo: 'Baixo', medio: 'Médio', alto: 'Alto', critico: 'Crítico' };
    const ROTULO_SLA = { ok: 'No prazo', em_risco: 'Em risco', vencido: 'Vencido', sem_sla: '—' };
    const ROTULO_PAPEL = {
        colaborador: 'Colaborador', analista: 'Analista', lider: 'Líder',
        coordenador: 'Coordenador', administrador: 'Administrador',
    };

    function chipGravidade(g) {
        if (!g) return '<span class="qualidade-tag">—</span>';
        return `<span class="selo-gravidade grav-${esc(g)}">${esc(g)}</span>`;
    }
    function chipStatus(s) { return `<span class="badge-status st-${esc(s)}">${esc(ROTULO_STATUS[s] || s)}</span>`; }
    function chipPrioridade(p) { return p ? `<span class="prio-badge prio-${esc(p)}">${esc(p)}</span>` : '—'; }
    function chipSla(s) {
        if (!s || s === 'sem_sla') return '<span class="sla-sem_sla">—</span>';
        return `<span class="sla-chip sla-${esc(s)}">${esc(ROTULO_SLA[s] || s)}</span>`;
    }

    // --- Cabeçalho e menu --------------------------------------------- //
    document.getElementById('nome-usuario').textContent = usuario.nome;
    document.getElementById('badge-nivel').textContent = ROTULO_PAPEL[papel] || 'Usuário';
    document.getElementById('btn-sair').addEventListener('click', () => API.sair());

    const menu = document.getElementById('menu-lateral');
    // Grupos com sub-abas: o item de menu abre a primeira sub-aba e mostra a barra de sub-navegação.
    const GRUPOS = {
        chamados: [
            { id: 'gestao', rotulo: 'Lista' },
            { id: 'minhafila', rotulo: 'Minha fila' },
            { id: 'kanban', rotulo: 'Kanban' },
        ],
        administracao: [
            { id: 'usuarios', rotulo: 'Usuários' },
            { id: 'modelos', rotulo: 'Modelos' },
            { id: 'config', rotulo: 'SLA & Feriados' },
            { id: 'categorias', rotulo: 'Categorias' },
            { id: 'auditoria', rotulo: 'Auditoria' },
        ],
    };
    // Mapa sub-página → grupo pai (para destacar o item de menu correto).
    const PAI = {};
    Object.entries(GRUPOS).forEach(([g, subs]) => subs.forEach(s => { PAI[s.id] = g; }));

    const itensMenu = ehAdmin
        ? [
            { id: 'dashboard', ico: '📊', rotulo: 'Painel' },
            { id: 'chamados', ico: '🗂️', rotulo: 'Chamados', grupo: true },
            { id: 'calendario', ico: '📅', rotulo: 'Calendário' },
            { id: 'kb', ico: '📚', rotulo: 'Conhecimento' },
            { id: 'administracao', ico: '⚙️', rotulo: 'Administração', grupo: true },
            { id: 'ajuda', ico: '❓', rotulo: 'Como usar' },
          ]
        : [
            { id: 'abrir', ico: '➕', rotulo: 'Abrir chamado' },
            { id: 'meus', ico: '📋', rotulo: 'Meus chamados' },
            { id: 'calendario', ico: '📅', rotulo: 'Calendário' },
            { id: 'kb', ico: '📚', rotulo: 'Conhecimento' },
            { id: 'ajuda', ico: '❓', rotulo: 'Como usar' },
          ];
    itensMenu.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'item-menu';
        btn.dataset.pagina = item.id;
        btn.innerHTML = `<span class="ico">${item.ico}</span><span>${item.rotulo}</span>`;
        // Item de grupo abre a primeira sub-aba; item simples navega direto.
        // Clicar no menu zera a busca global (a busca chama navegar() direto).
        btn.addEventListener('click', () => {
            buscaMeusTexto = '';
            navegar(item.grupo ? GRUPOS[item.id][0].id : item.id);
        });
        menu.appendChild(btn);
    });

    const subnav = document.getElementById('subnav');
    function renderSubnav(grupo, ativo) {
        if (!subnav) return;
        if (!grupo || !GRUPOS[grupo]) { subnav.innerHTML = ''; subnav.classList.remove('ativa'); return; }
        subnav.classList.add('ativa');
        subnav.innerHTML = '';
        GRUPOS[grupo].forEach(s => {
            const b = document.createElement('button');
            b.className = 'subnav-item' + (s.id === ativo ? ' ativo' : '');
            b.textContent = s.rotulo;
            b.addEventListener('click', () => navegar(s.id));
            subnav.appendChild(b);
        });
    }

    function navegar(pagina) {
        // "minhafila" reaproveita a tela de gestão (pg-gestao) com filtro "atribuídos a mim".
        gestaoMinhaFila = pagina === 'minhafila';
        const pgId = pagina === 'minhafila' ? 'gestao' : pagina;

        document.querySelectorAll('.pagina').forEach(p => p.classList.remove('ativa'));
        document.querySelectorAll('.item-menu').forEach(b => b.classList.remove('ativo'));
        const sec = document.getElementById('pg-' + pgId);
        if (sec) sec.classList.add('ativa');

        const grupo = PAI[pagina];
        const btn = document.querySelector(`.item-menu[data-pagina="${grupo || pagina}"]`);
        if (btn) btn.classList.add('ativo');
        renderSubnav(grupo, pagina);

        if (pagina === 'meus') carregarMeusChamados();
        if (pagina === 'equipe') carregarEquipe();
        if (pagina === 'gestao' || pagina === 'minhafila') carregarGestao();
        if (pagina === 'kanban') carregarKanban();
        if (pagina === 'kb') carregarKb();
        if (pagina === 'dashboard') carregarDashboard();
        if (pagina === 'usuarios') carregarUsuarios();
        if (pagina === 'auditoria') carregarAuditoria();
        if (pagina === 'abrir') carregarCategoriasAbrir();
        if (pagina === 'ajuda') carregarAjuda();
        if (pagina === 'modelos') carregarModelos();
        if (pagina === 'config') carregarConfig();
        if (pagina === 'categorias') carregarCategoriasAdmin();
        if (pagina === 'calendario') carregarCalendarioGeral();
    }
    window.navegar = navegar;

    // Aba "Como usar": mostra o perfil logado e destaca a seção dele.
    function carregarAjuda() {
        const quem = document.getElementById('ajuda-quem');
        if (quem) quem.textContent = `${usuario.nome} (${ROTULO_PAPEL[papel] || 'Usuário'})`;
        const alvoId = ehAdmin ? 'sec-admin'
            : ((RANK[papel] || 1) >= RANK.analista ? 'sec-lider' : 'sec-solicitante');
        document.querySelectorAll('.ajuda-sec.destaque').forEach(s => s.classList.remove('destaque'));
        const alvo = document.getElementById(alvoId);
        if (alvo) { alvo.classList.add('destaque'); alvo.open = true; }
    }

    // ================================================================== //
    // CACHES compartilhados
    // ================================================================== //
    let categoriasCache = [];
    let usuariosCache = [];
    let equipeCache = [];
    let meusChamadosCache = [];

    // Para não-admin com subordinados: carrega a equipe, adiciona a aba e
    // popula o filtro de solicitante.
    if (!ehAdmin) initEquipe();
    async function initEquipe() {
        try { equipeCache = await API.minhaEquipe(); } catch (e) { equipeCache = []; }
        if (!equipeCache.length) return;

        // Adiciona a aba "Minha equipe" no menu (depois de "Meus chamados").
        const btn = document.createElement('button');
        btn.className = 'item-menu';
        btn.dataset.pagina = 'equipe';
        btn.innerHTML = `<span class="ico">👥</span><span>Minha equipe</span>`;
        btn.addEventListener('click', () => navegar('equipe'));
        menu.appendChild(btn);

        // Popula o filtro de solicitante em "Meus chamados".
        const sel = document.getElementById('filtro-solicitante');
        if (sel) {
            sel.innerHTML = '<option value="">Todos</option>'
                + `<option value="${usuario.id}">Apenas os meus</option>`
                + equipeCache.map(m => `<option value="${m.id}">${esc(m.nome)}</option>`).join('');
            sel.addEventListener('change', renderMeus);
        }
    }

    async function garantirCategorias() {
        if (categoriasCache.length) return categoriasCache;
        try { categoriasCache = await API.categoriasAbertura(); } catch (e) { categoriasCache = []; }
        return categoriasCache;
    }
    async function garantirUsuarios() {
        if (usuariosCache.length) return usuariosCache;
        try { usuariosCache = await API.usuarios(); } catch (e) { usuariosCache = []; }
        return usuariosCache;
    }

    function preencherSelectCategorias(sel, cats, valor) {
        sel.innerHTML = '<option value="">Selecione...</option>' +
            cats.map(c => `<option value="${c.id}" ${valor == c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('');
    }
    function preencherSelectSubcategorias(sel, cats, catId, valor) {
        const cat = cats.find(c => c.id == catId);
        const subs = cat ? cat.subcategorias : [];
        sel.innerHTML = '<option value="">Selecione...</option>' +
            subs.map(s => `<option value="${s.id}" ${valor == s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('');
    }

    // ================================================================== //
    // SOLICITANTE
    // ================================================================== //
    let templatesCache = [];
    // Renderiza os campos personalizados de um modelo (chamado modular).
    function renderCamposTemplate(t) {
        const wrap = document.getElementById('campos-template');
        if (!wrap) return;
        const campos = (t && t.campos_personalizados) || [];
        if (!campos.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
        let html = '<div class="campos-template-titulo">📋 Detalhes do modelo</div>';
        campos.forEach(c => {
            const id = 'cp-' + c.chave;
            const req = c.obrigatorio ? ' <span class="cp-obrig">*</span>' : '';
            const dt = `data-chave="${esc(c.chave)}" data-tipo="${esc(c.tipo)}"`;
            const padrao = c.padrao || '';
            const padroes = padrao.split(',').map(s => s.trim());  // p/ múltipla
            let campo;
            if (c.tipo === 'booleano') {
                const on = ['sim', 'true', '1', 'on'].includes(padrao.toLowerCase());
                campo = `<label class="cp-check"><input type="checkbox" id="${id}" ${dt} ${on ? 'checked' : ''}> ${esc(c.rotulo)}${req}</label>`;
            } else if (c.tipo === 'multipla') {
                const ops = (c.opcoes || []).map(o =>
                    `<label class="cp-check"><input type="checkbox" value="${esc(o)}" ${padroes.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('');
                campo = `<label>${esc(c.rotulo)}${req}</label><div class="cp-grupo" ${dt}>${ops}</div>`;
            } else if (c.tipo === 'selecao') {
                const ops = (c.opcoes || []).map(o => `<option value="${esc(o)}" ${padrao === o ? 'selected' : ''}>${esc(o)}</option>`).join('');
                campo = `<label for="${id}">${esc(c.rotulo)}${req}</label><select id="${id}" ${dt}><option value="">Selecione...</option>${ops}</select>`;
            } else if (c.tipo === 'texto_longo') {
                campo = `<label for="${id}">${esc(c.rotulo)}${req}</label><textarea id="${id}" ${dt}>${esc(padrao)}</textarea>`;
            } else {
                const html5 = c.tipo === 'numero' ? 'number' : c.tipo === 'data' ? 'date' : 'text';
                campo = `<label for="${id}">${esc(c.rotulo)}${req}</label><input type="${html5}" id="${id}" ${dt} value="${esc(padrao)}">`;
            }
            html += `<div class="campo">${campo}</div>`;
        });
        wrap.innerHTML = html;
        wrap.style.display = '';
    }

    // Mostra/oculta os campos PADRÃO da abertura conforme o modelo escolhido.
    // Sem modelo (t nulo) ou modelo sem config → mostra todos.
    function aplicarCamposPadrao(t) {
        Object.entries(MAPA_CAMPOS_PADRAO).forEach(([k, id]) => {
            const el = document.getElementById(id);
            const wrap = el && el.closest('.campo');
            if (!wrap) return;
            const oculto = !!(t && t.campos_padrao && t.campos_padrao[k] === false);
            wrap.style.display = oculto ? 'none' : '';
        });
    }

    // Coleta as respostas dos campos personalizados num mapa chave→valor.
    function coletarCamposTemplate() {
        const wrap = document.getElementById('campos-template');
        const out = {};
        if (!wrap || wrap.style.display === 'none') return out;
        wrap.querySelectorAll('[data-chave]').forEach(el => {
            const chave = el.dataset.chave, tipo = el.dataset.tipo;
            if (tipo === 'multipla') {
                out[chave] = Array.from(el.querySelectorAll('input:checked')).map(i => i.value);
            } else if (tipo === 'booleano') {
                out[chave] = el.checked;
            } else {
                out[chave] = el.value;
            }
        });
        return out;
    }

    // Valida os obrigatórios localmente (mensagem amigável antes do servidor).
    function validarCamposTemplate(valores) {
        if (!templateAtivo) return null;
        for (const c of (templateAtivo.campos_personalizados || [])) {
            if (!c.obrigatorio) continue;
            const v = valores[c.chave];
            const vazio = c.tipo === 'multipla' ? !(v && v.length)
                : c.tipo === 'booleano' ? false
                : !String(v == null ? '' : v).trim();
            if (vazio) return `Preencha o campo obrigatório "${c.rotulo}".`;
        }
        return null;
    }

    async function carregarCategoriasAbrir() {
        if (ehAdmin) return;
        const cats = await garantirCategorias();
        const selCat = document.getElementById('abrir-categoria');
        const selSub = document.getElementById('abrir-subcategoria');
        if (!selCat) return;
        preencherSelectCategorias(selCat, cats);
        selCat.onchange = () => preencherSelectSubcategorias(selSub, cats, selCat.value);

        // Modelos (templates) — preenchem o formulário.
        if (!templatesCache.length) {
            try { templatesCache = await API.templatesAbertura(); } catch (e) { templatesCache = []; }
        }
        const selT = document.getElementById('abrir-template');
        if (selT && templatesCache.length) {
            document.getElementById('campo-template').style.display = '';
            selT.innerHTML = '<option value="">Começar do zero...</option>'
                + templatesCache.map(t => `<option value="${t.id}">${esc(t.nome)}</option>`).join('');
            selT.onchange = () => {
                const t = templatesCache.find(x => x.id == selT.value);
                templateAtivo = t || null;        // controla os campos modulares
                renderCamposTemplate(t);          // "do zero" (t indefinido) → limpa
                aplicarCamposPadrao(t);           // mostra/oculta os campos padrão
                if (!t) return;
                document.getElementById('titulo').value = t.titulo || '';
                document.getElementById('descricao').value = t.descricao || '';
                if (t.sistema_afetado) document.getElementById('abrir-sistema').value = t.sistema_afetado;
                if (t.impacto_negocio) document.getElementById('abrir-impacto').value = t.impacto_negocio;
                if (t.categoria_id) {
                    selCat.value = t.categoria_id;
                    preencherSelectSubcategorias(selSub, cats, t.categoria_id);
                    if (t.subcategoria_id) selSub.value = t.subcategoria_id;
                }
                document.getElementById('descricao').dispatchEvent(new Event('input'));
            };
        }
    }

    if (!ehAdmin) {
        const $btnAbrir = document.getElementById('btn-abrir');
        const $alerta = document.getElementById('alerta-abrir');
        const val = id => document.getElementById(id).value.trim();

        function alertaAbrir(msg, tipo) { $alerta.textContent = msg; $alerta.className = `alerta ${tipo} visivel`; }

        // Contador de caracteres da descrição.
        const $desc = document.getElementById('descricao');
        const $tit = document.getElementById('titulo');
        const $cont = document.getElementById('contador-desc');
        const atualizarContador = () => { if ($cont) $cont.textContent = `${$desc.value.length} / 5000`; };
        $desc.addEventListener('input', atualizarContador);
        atualizarContador();

        // Deflexão: busca soluções enquanto o usuário digita (debounced).
        const $deflPainel = document.getElementById('deflexao-painel');
        const $deflRes = document.getElementById('deflexao-resultados');
        let deflTimer;
        async function buscarDeflexao() {
            const titulo = $tit.value.trim(), descricao = $desc.value.trim();
            if ((titulo + descricao).length < 10) { $deflPainel.style.display = 'none'; return; }
            try {
                const r = await API.deflexao(titulo, descricao);
                const itens = [
                    ...r.artigos.map(a => `<div class="kb-item" data-tipo="artigo" data-id="${a.id}">
                        <div class="kb-titulo">📚 ${esc(a.titulo)}</div></div>`),
                    ...r.similares.map(s => `<div class="kb-item">
                        🔗 ${esc(s.numero_protocolo || '#' + s.id)} — ${esc(s.titulo)} ${chipStatus(s.status)}</div>`),
                ];
                if (!itens.length) { $deflPainel.style.display = 'none'; return; }
                $deflRes.innerHTML = itens.join('');
                $deflRes.querySelectorAll('.kb-item[data-tipo="artigo"]').forEach(el =>
                    el.addEventListener('click', () => abrirArtigo(+el.dataset.id)));
                $deflPainel.style.display = 'block';
            } catch (e) { /* silencioso */ }
        }
        const agendarDeflexao = () => { clearTimeout(deflTimer); deflTimer = setTimeout(buscarDeflexao, 600); };
        $tit.addEventListener('input', agendarDeflexao);
        $desc.addEventListener('input', agendarDeflexao);

        // "Isso resolveu, não preciso abrir" — registra a deflexão.
        document.getElementById('btn-deflexao-resolvi').addEventListener('click', async () => {
            try { await API.deflexaoAproveitada(); } catch (e) { /* segue */ }
            $deflPainel.style.display = 'none';
            alertaAbrir('Que bom que resolveu! 🎉 Nada foi aberto.', 'sucesso');
            ['titulo', 'descricao'].forEach(id => document.getElementById(id).value = '');
        });

        // Pré-visualização dos arquivos escolhidos.
        const $fileInput = document.getElementById('abrir-anexos');
        const $listaAnexos = document.getElementById('lista-anexos-abrir');
        $fileInput.addEventListener('change', () => {
            const arquivos = Array.from($fileInput.files || []);
            $listaAnexos.innerHTML = arquivos.map(f =>
                `<div class="anexo-item"><span>📎 ${esc(f.name)}</span><span style="color:var(--cor-texto-suave);">${(f.size / 1024).toFixed(0)} KB</span></div>`
            ).join('');
        });

        const MIN_DESC = 30;

        $btnAbrir.addEventListener('click', async () => {
            const titulo = val('titulo'), descricao = val('descricao');
            if (titulo.length < 3) return alertaAbrir('Informe um título com ao menos 3 caracteres.', 'erro');
            if (descricao.length < MIN_DESC)
                return alertaAbrir(`Descreva o problema com ao menos ${MIN_DESC} caracteres (faltam ${MIN_DESC - descricao.length}).`, 'erro');

            const dados = { titulo, descricao };
            const cat = val('abrir-categoria'); if (cat) dados.categoria_id = +cat;
            const sub = val('abrir-subcategoria'); if (sub) dados.subcategoria_id = +sub;
            const sis = val('abrir-sistema'); if (sis) dados.sistema_afetado = sis;
            const mod = val('abrir-modulo'); if (mod) dados.modulo_tela = mod;
            const imp = val('abrir-impacto'); if (imp) dados.impacto_negocio = imp;
            const urg = val('abrir-urgencia'); if (urg) dados.urgencia_solicitante = +urg;
            const uni = val('abrir-unidade'); if (uni) dados.unidade_setor = uni;
            const con = val('abrir-contato'); if (con) dados.contato_retorno = con;

            // Chamado modular: anexa o modelo e as respostas dos campos personalizados.
            if (templateAtivo) {
                const valores = coletarCamposTemplate();
                const faltou = validarCamposTemplate(valores);
                if (faltou) return alertaAbrir(faltou, 'erro');
                dados.template_id = templateAtivo.id;
                dados.campos_personalizados = valores;
            }

            const arquivos = Array.from($fileInput.files || []);

            $btnAbrir.disabled = true;
            $btnAbrir.innerHTML = '<span class="spinner"></span> Enviando...';
            try {
                const ch = await API.abrirChamado(dados);
                // Envia os anexos (se houver) após criar o chamado.
                let falhasAnexo = 0;
                for (const f of arquivos) {
                    try { await API.enviarAnexo(ch.id, f); } catch (e) { falhasAnexo++; }
                }
                ['titulo', 'descricao', 'abrir-sistema', 'abrir-modulo', 'abrir-unidade', 'abrir-contato']
                    .forEach(id => document.getElementById(id).value = '');
                $fileInput.value = ''; $listaAnexos.innerHTML = ''; atualizarContador();
                // Reseta o modelo e os campos modulares.
                const selTpl = document.getElementById('abrir-template');
                if (selTpl) selTpl.value = '';
                templateAtivo = null; renderCamposTemplate(null); aplicarCamposPadrao(null);
                const aviso = falhasAnexo
                    ? ` (${falhasAnexo} anexo(s) não enviados — verifique tipo/tamanho)`
                    : '';
                alertaAbrir(`Chamado ${ch.numero_protocolo || ''} aberto!${aviso} Acompanhe em "Meus chamados".`,
                    falhasAnexo ? 'erro' : 'sucesso');
            } catch (e) {
                alertaAbrir(e.message, 'erro');
            } finally {
                $btnAbrir.disabled = false;
                $btnAbrir.textContent = 'Abrir chamado';
            }
        });
    }

    async function carregarMeusChamados() {
        const corpo = document.getElementById('corpo-meus');
        corpo.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;">Carregando...</td></tr>`;
        try {
            meusChamadosCache = await API.meusChamados();
            renderMeus();
        } catch (e) {
            corpo.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#b3261e;">${esc(e.message)}</td></tr>`;
        }
    }

    function renderMeus() {
        const corpo = document.getElementById('corpo-meus');
        const vazio = document.getElementById('vazio-meus');
        const selEl = document.getElementById('filtro-solicitante');
        const filtro = selEl ? selEl.value : '';
        let lista = filtro
            ? meusChamadosCache.filter(c => c.autor && String(c.autor.id) === String(filtro))
            : meusChamadosCache;
        if (buscaMeusTexto) {
            const t = buscaMeusTexto.toLowerCase();
            lista = lista.filter(c =>
                (c.titulo || '').toLowerCase().includes(t) ||
                (c.numero_protocolo || '').toLowerCase().includes(t));
        }

        corpo.innerHTML = '';
        if (!lista.length) { vazio.style.display = 'block'; return; }
        vazio.style.display = 'none';
        lista.forEach(c => {
            const meu = c.autor && c.autor.id === usuario.id;
            const solicitante = meu
                ? '<strong>Você</strong>'
                : `${esc(c.autor.nome)}<br><span style="font-size:12px;color:var(--cor-texto-suave);">equipe</span>`;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="id-chamado">${esc(c.numero_protocolo || '#' + c.id)}</td>
                <td class="titulo-cel">${esc(c.titulo)}</td>
                <td>${solicitante}</td>
                <td>${chipGravidade(c.gravidade)}</td>
                <td>${chipStatus(c.status)}</td>
                <td>${formatarData(c.criado_em)}</td>
                <td><button class="btn-mini">Ver</button></td>`;
            tr.querySelector('button').addEventListener('click', () => abrirModalUsuario(c.id));
            corpo.appendChild(tr);
        });
    }

    async function carregarEquipe() {
        const corpo = document.getElementById('corpo-equipe');
        const vazio = document.getElementById('vazio-equipe');
        corpo.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;">Carregando...</td></tr>`;
        try {
            equipeCache = await API.minhaEquipe();
            corpo.innerHTML = '';
            if (!equipeCache.length) { vazio.style.display = 'block'; return; }
            vazio.style.display = 'none';
            equipeCache.forEach(m => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${esc(m.nome)}</strong><br><span style="font-size:12px;color:var(--cor-texto-suave);">${esc(m.matricula)}</span></td>
                    <td>${esc(ROTULO_PAPEL[m.papel] || m.papel)}</td>
                    <td>${esc(m.supervisor_nome || '—')}</td>
                    <td>${esc(m.unidade_setor || '—')}</td>
                    <td><strong>${m.abertos}</strong></td>
                    <td>${m.total}</td>
                    <td><button class="btn-mini">Ver chamados</button></td>`;
                tr.querySelector('button').addEventListener('click', () => {
                    const sel = document.getElementById('filtro-solicitante');
                    if (sel) sel.value = String(m.id);
                    buscaMeusTexto = '';
                    navegar('meus');
                });
                corpo.appendChild(tr);
            });
        } catch (e) {
            corpo.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#b3261e;">${esc(e.message)}</td></tr>`;
        }
    }

    function renderTimeline(comentarios) {
        if (!comentarios || !comentarios.length)
            return '<div class="val" style="color:var(--cor-texto-suave);">Sem interações ainda.</div>';
        return '<div class="timeline">' + comentarios.map(c => `
            <div class="coment ${c.interno ? 'interno' : ''}">
                <div class="coment-topo">
                    <span class="coment-autor">${esc(c.autor.nome)} ${c.interno ? '<span class="tag-interno">interno</span>' : ''}</span>
                    <span>${formatarData(c.criado_em)}</span>
                </div>
                <div class="coment-corpo">${esc(c.corpo)}</div>
            </div>`).join('') + '</div>';
    }

    function alertaModal(msg) {
        const a = document.getElementById('modal-alerta');
        if (a) { a.textContent = msg; a.className = 'alerta erro visivel'; }
    }

    function ehImagem(nome) { return /\.(png|jpe?g|gif|webp|bmp)$/i.test(nome || ''); }

    // Mostra as respostas dos campos personalizados (chamado modular) no detalhe.
    function renderCamposDet(c) {
        const campos = c.campos_personalizados || [];
        if (!campos.length) return '';
        const linhas = campos.map(f =>
            `<div class="cp-det-item"><span class="cp-det-rot">${esc(f.rotulo)}</span>
             <span class="cp-det-val">${esc(f.valor)}</span></div>`).join('');
        return `<div class="detalhe-linha"><div class="rot">Campos do modelo</div>
            <div class="cp-det">${linhas}</div></div>`;
    }

    function renderAnexos(c) {
        if (!c.anexos || !c.anexos.length) return '';
        const imgs = c.anexos.filter(a => ehImagem(a.nome_original));
        const thumbs = imgs.map(a => `
            <button type="button" class="anexo-thumb" data-cid="${c.id}" data-aid="${a.id}"
                    data-nome="${esc(a.nome_original)}" title="${esc(a.nome_original)}">
                <img alt="${esc(a.nome_original)}" data-thumb="${c.id}-${a.id}">
            </button>`).join('');
        const itens = c.anexos.map(a => `
            <button type="button" class="anexo-item anexo-baixar"
                    data-cid="${c.id}" data-aid="${a.id}" data-nome="${esc(a.nome_original)}">
                <span>${ehImagem(a.nome_original) ? '🖼️' : '📎'} ${esc(a.nome_original)}</span>
                <span style="color:var(--cor-primaria);font-weight:600;">baixar</span>
            </button>`).join('');
        return `<div class="detalhe-linha"><div class="rot">Anexos (${c.anexos.length})</div>
            ${thumbs ? `<div class="anexo-thumbs">${thumbs}</div>` : ''}${itens}</div>`;
    }

    // Carrega (sob demanda) as miniaturas de imagem visíveis no modal aberto.
    async function carregarThumbsAnexos() {
        const imgs = document.querySelectorAll('#modal-corpo img[data-thumb]:not([data-carregando])');
        imgs.forEach(async img => {
            if (img.getAttribute('src')) return;
            img.dataset.carregando = '1';
            const [cid, aid] = img.dataset.thumb.split('-');
            try {
                const blob = await API.baixarAnexo(+cid, +aid);
                img.src = URL.createObjectURL(blob);
            } catch (_) { const w = img.closest('.anexo-thumb'); if (w) w.remove(); }
        });
    }
    // Observa o corpo do modal: ao renderizar anexos, dispara o carregamento das miniaturas.
    const _modalCorpo = document.getElementById('modal-corpo');
    if (_modalCorpo) new MutationObserver(() => carregarThumbsAnexos())
        .observe(_modalCorpo, { childList: true, subtree: true });

    function abrirLightbox(src, nome) {
        let lb = document.getElementById('lightbox');
        if (!lb) {
            lb = document.createElement('div');
            lb.id = 'lightbox'; lb.className = 'lightbox';
            lb.innerHTML = `<button class="lightbox-fechar" aria-label="Fechar">&times;</button>
                <figure><img alt=""><figcaption></figcaption></figure>`;
            lb.addEventListener('click', e => {
                if (e.target === lb || e.target.classList.contains('lightbox-fechar')) lb.style.display = 'none';
            });
            document.body.appendChild(lb);
        }
        lb.querySelector('img').src = src;
        lb.querySelector('figcaption').textContent = nome || '';
        lb.style.display = 'flex';
    }

    async function baixarAnexoArquivo(cid, aid, nome) {
        try {
            const blob = await API.baixarAnexo(cid, aid);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = nome || 'anexo';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (e) { alert(e.message); }
    }
    document.addEventListener('click', e => {
        if (!e.target.closest) return;
        const baixar = e.target.closest('.anexo-baixar');
        if (baixar) { baixarAnexoArquivo(+baixar.dataset.cid, +baixar.dataset.aid, baixar.dataset.nome); return; }
        const thumb = e.target.closest('.anexo-thumb');
        if (thumb) {
            const img = thumb.querySelector('img');
            if (img && img.getAttribute('src')) abrirLightbox(img.src, thumb.dataset.nome);
        }
    });

    async function abrirModalUsuario(id) {
        let c;
        try { c = await API.detalheChamado(id); } catch (e) { return alert(e.message); }
        document.getElementById('modal-titulo').textContent = `Chamado ${c.numero_protocolo || '#' + c.id}`;
        const encerrado = ['resolvido', 'fechado', 'cancelado'].includes(c.status);
        const jaAvaliou = !!c.avaliacao;
        // Só pode comentar/avaliar o PRÓPRIO chamado; de subordinado é leitura.
        const meu = c.autor && c.autor.id === usuario.id;
        document.getElementById('modal-corpo').innerHTML = `
            <div class="detalhe-linha"><div class="rot">Título</div><div class="val">${esc(c.titulo)}</div></div>
            <div class="detalhe-linha"><div class="rot">Descrição</div><div class="detalhe-descricao">${esc(c.descricao)}</div></div>
            <div class="detalhe-linha detalhe-grade">
                <div><div class="rot">Gravidade</div>${chipGravidade(c.gravidade)}</div>
                <div><div class="rot">Status</div>${chipStatus(c.status)}</div>
                <div><div class="rot">Aberto em</div><div class="val">${formatarData(c.criado_em)}</div></div>
                <div><div class="rot">SLA</div>${chipSla(c.sla_status)}</div>
            </div>
            ${renderCamposDet(c)}
            ${renderAnexos(c)}
            <div class="detalhe-linha"><div class="rot">Histórico</div>${renderTimeline(c.comentarios)}</div>
            ${meu && !encerrado ? `
            <div class="campo"><label for="user-coment">Adicionar comentário</label>
                <textarea id="user-coment" maxlength="5000" placeholder="Escreva uma atualização..."></textarea></div>
            <button class="btn btn-secundario btn-mini" id="user-enviar-coment">Enviar comentário</button>` : ''}
            ${meu && encerrado && !jaAvaliou ? `
            <div class="detalhe-linha" style="margin-top:18px;"><div class="rot">Avalie o atendimento (CSAT)</div>
                <div class="campo"><select id="user-nota">
                    <option value="5">★★★★★ — Ótimo</option><option value="4">★★★★ — Bom</option>
                    <option value="3">★★★ — Regular</option><option value="2">★★ — Ruim</option>
                    <option value="1">★ — Péssimo</option></select></div>
                <button class="btn btn-primario btn-mini" id="user-avaliar">Enviar avaliação</button></div>` : ''}
            ${jaAvaliou ? `<div class="detalhe-linha"><div class="rot">Sua avaliação</div>
                <div class="estrelas">${'★'.repeat(c.avaliacao.nota)}${'☆'.repeat(5 - c.avaliacao.nota)}</div></div>` : ''}
            ${!encerrado ? `
            <div class="detalhe-linha" style="margin-top:18px;border-top:1px solid var(--cor-borda);padding-top:16px;">
                <button class="btn btn-fantasma btn-mini" id="user-toggle-cancelar"
                        style="color:var(--grav-critica);border-color:var(--grav-critica);">✕ Cancelar chamado</button>
                <div id="user-cancelar-box" style="display:none;margin-top:12px;">
                    <div class="campo"><label for="user-cancelar-motivo">Motivo do cancelamento *</label>
                        <textarea id="user-cancelar-motivo" placeholder="Explique por que este chamado está sendo cancelado..." style="min-height:70px;"></textarea></div>
                    <button class="btn btn-perigo btn-mini" id="user-confirmar-cancelar">Confirmar cancelamento</button>
                </div>
            </div>` : ''}
            ${meu && encerrado ? `
            <div class="detalhe-linha" style="margin-top:18px;border-top:1px solid var(--cor-borda);padding-top:16px;">
                <button class="btn btn-fantasma btn-mini" id="user-reabrir">↺ Reabrir chamado</button>
                <div class="ajuda">Reabra se o problema voltou ou não foi resolvido.</div>
            </div>` : ''}
            <div id="modal-alerta" class="alerta"></div>`;

        document.getElementById('modal-rodape').innerHTML =
            `<button class="btn btn-secundario" id="fechar-rodape">Fechar</button>`;
        document.getElementById('fechar-rodape').addEventListener('click', fecharModal);

        const btnReabrir = document.getElementById('user-reabrir');
        if (btnReabrir) btnReabrir.addEventListener('click', async () => {
            if (!confirm('Reabrir este chamado?')) return;
            try {
                await API.reabrir(id);
                meusChamadosCache = await API.meusChamados();
                renderMeus();
                abrirModalUsuario(id);
            } catch (e) { alertaModal(e.message); }
        });

        const btnComent = document.getElementById('user-enviar-coment');
        if (btnComent) btnComent.addEventListener('click', async () => {
            const txt = document.getElementById('user-coment').value.trim();
            if (!txt) return;
            try { await API.comentar(id, txt); abrirModalUsuario(id); } catch (e) { alertaModal(e.message); }
        });
        const btnAval = document.getElementById('user-avaliar');
        if (btnAval) btnAval.addEventListener('click', async () => {
            try { await API.avaliar(id, +document.getElementById('user-nota').value); abrirModalUsuario(id); }
            catch (e) { alertaModal(e.message); }
        });
        const btnToggleCanc = document.getElementById('user-toggle-cancelar');
        if (btnToggleCanc) btnToggleCanc.addEventListener('click', () => {
            const box = document.getElementById('user-cancelar-box');
            box.style.display = box.style.display === 'none' ? 'block' : 'none';
        });
        const btnConfCanc = document.getElementById('user-confirmar-cancelar');
        if (btnConfCanc) btnConfCanc.addEventListener('click', async () => {
            const motivo = document.getElementById('user-cancelar-motivo').value.trim();
            if (motivo.length < 5) return alertaModal('Informe um motivo com ao menos 5 caracteres.');
            btnConfCanc.disabled = true; btnConfCanc.innerHTML = '<span class="spinner"></span> Cancelando...';
            try {
                await API.cancelarChamado(id, motivo);
                meusChamadosCache = await API.meusChamados();
                renderMeus();
                abrirModalUsuario(id);
            } catch (e) {
                alertaModal(e.message);
                btnConfCanc.disabled = false; btnConfCanc.textContent = 'Confirmar cancelamento';
            }
        });
        mostrarModal();
    }

    // ================================================================== //
    // EQUIPE / ADMIN — Gestão de chamados
    // ================================================================== //
    const TAM_PAGINA = 25;
    let paginaGestao = 0;
    const selecionados = new Set();

    async function carregarGestao() {
        const corpo = document.getElementById('corpo-gestao');
        const vazio = document.getElementById('vazio-gestao');
        corpo.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:30px;">Carregando...</td></tr>`;
        const filtros = {
            status: document.getElementById('filtro-status').value,
            gravidade: document.getElementById('filtro-gravidade').value,
            categoria: document.getElementById('filtro-categoria').value,
            sla: document.getElementById('filtro-sla').value,
            tag: document.getElementById('filtro-tag').value.trim(),
            de: document.getElementById('filtro-de').value,
            ate: document.getElementById('filtro-ate').value,
            busca: document.getElementById('filtro-busca').value.trim(),
            limite: TAM_PAGINA,
            offset: paginaGestao * TAM_PAGINA,
        };
        // Sub-aba "Minha fila": só chamados atribuídos ao usuário logado.
        if (gestaoMinhaFila) filtros.atribuido = usuario.id;
        const tituloGestao = document.getElementById('titulo-gestao');
        if (tituloGestao) tituloGestao.textContent = gestaoMinhaFila ? 'Minha fila' : 'Gestão de chamados';
        try {
            const chamados = await API.todosChamados(filtros);
            document.getElementById('pg-info').textContent = `Página ${paginaGestao + 1}`;
            document.getElementById('pg-anterior').disabled = paginaGestao === 0;
            document.getElementById('pg-proxima').disabled = chamados.length < TAM_PAGINA;

            corpo.innerHTML = '';
            if (!chamados.length) { vazio.style.display = 'block'; atualizarBarraMassa(); return; }
            vazio.style.display = 'none';
            chamados.forEach(c => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><input type="checkbox" class="chk-massa" value="${c.id}" ${selecionados.has(c.id) ? 'checked' : ''}></td>
                    <td class="id-chamado">${esc(c.numero_protocolo || '#' + c.id)}</td>
                    <td>${chipPrioridade(c.prioridade)}</td>
                    <td class="titulo-cel">${esc(c.titulo)}</td>
                    <td>${esc(c.autor.nome)}<br><span style="font-size:12px;color:var(--cor-texto-suave);">${esc(c.autor.matricula)}</span></td>
                    <td>${c.atribuido_a ? esc(c.atribuido_a.nome) : '<span style="color:var(--cor-texto-suave);">—</span>'}</td>
                    <td>${chipGravidade(c.gravidade)}</td>
                    <td>${chipStatus(c.status)}</td>
                    <td>${chipSla(c.sla_status)}</td>
                    <td><button class="btn-mini">Atender</button></td>`;
                tr.querySelector('button').addEventListener('click', () => abrirModalAdmin(c.id));
                tr.querySelector('.chk-massa').addEventListener('change', e => {
                    if (e.target.checked) selecionados.add(c.id); else selecionados.delete(c.id);
                    atualizarBarraMassa();
                });
                corpo.appendChild(tr);
            });
            atualizarBarraMassa();
        } catch (e) {
            corpo.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:30px;color:#b3261e;">${esc(e.message)}</td></tr>`;
        }
    }

    function atualizarBarraMassa() {
        const barra = document.getElementById('barra-massa');
        if (!barra) return;
        document.getElementById('massa-contador').textContent = `${selecionados.size} selecionado(s)`;
        barra.style.display = selecionados.size ? 'flex' : 'none';
    }

    async function abrirModalAdmin(id) {
        let c, trans;
        try { [c, trans] = await Promise.all([API.detalheAdmin(id), API.transicoes(id)]); }
        catch (e) { return alert(e.message); }
        const cats = await garantirCategorias();
        const equipe = await garantirUsuarios();
        let versao = c.versao_linha;

        document.getElementById('modal-titulo').textContent =
            `Chamado ${c.numero_protocolo || '#' + c.id} — Atendimento`;

        const optsStatus = [c.status, ...trans.permitidos.filter(s => s !== c.status)]
            .map(s => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${ROTULO_STATUS[s] || s}</option>`).join('');
        const optsGrav = ['Baixa', 'Média', 'Alta', 'Crítica']
            .map(g => `<option value="${g}" ${g === c.gravidade ? 'selected' : ''}>${g}</option>`).join('');
        const optsPrio = [1, 2, 3, 4, 5]
            .map(p => `<option value="${p}" ${p === c.prioridade ? 'selected' : ''}>P${p}</option>`).join('');
        const optsImp = ['', 'baixo', 'medio', 'alto', 'critico']
            .map(i => `<option value="${i}" ${i === (c.impacto_negocio || '') ? 'selected' : ''}>${i ? ROTULO_IMPACTO[i] : '—'}</option>`).join('');
        const optsResp = ['<option value="">— sem responsável —</option>'].concat(
            equipe.filter(u => (RANK[u.papel] || 1) >= RANK.analista)
                .map(u => `<option value="${u.id}" ${u.id === (c.atribuido_a && c.atribuido_a.id) ? 'selected' : ''}>${esc(u.nome)}</option>`)
        ).join('');

        document.getElementById('modal-corpo').innerHTML = `
            <div class="abas">
                <button type="button" class="aba ativa" data-aba="atendimento">Atendimento</button>
                <button type="button" class="aba" data-aba="triagem">Triagem &amp; classificação</button>
                <button type="button" class="aba" data-aba="conhecimento">Conhecimento</button>
                <button type="button" class="aba" data-aba="historico">Histórico</button>
            </div>

            <!-- ABA: ATENDIMENTO -->
            <div class="aba-painel" id="painel-atendimento">
                <div class="detalhe-linha detalhe-grade">
                    <div><div class="rot">Solicitante</div><div class="val">${esc(c.autor.nome)} · ${esc(c.autor.matricula)}</div></div>
                    <div><div class="rot">Sistema</div><div class="val">${esc(c.sistema_afetado || '—')}</div></div>
                    <div><div class="rot">Módulo/Tela</div><div class="val">${esc(c.modulo_tela || '—')}</div></div>
                    <div><div class="rot">Unidade</div><div class="val">${esc(c.unidade_setor || '—')}</div></div>
                    <div><div class="rot">Contato</div><div class="val">${esc(c.contato_retorno || '—')}</div></div>
                    <div><div class="rot">SLA</div>${chipSla(c.sla_status)} <span style="font-size:12px;color:var(--cor-texto-suave);">${c.sla_prazo ? 'até ' + formatarData(c.sla_prazo) : ''}</span></div>
                </div>
                <div class="detalhe-linha"><div class="rot">Descrição</div><div class="detalhe-descricao">${esc(c.descricao)}</div></div>
                ${renderCamposDet(c)}
                ${renderAnexos(c)}

                <div class="campo"><label for="m-status">Status</label><select id="m-status">${optsStatus}</select></div>

                <div class="campo"><label for="m-resposta">Resposta ao solicitante (pública)</label>
                    <textarea id="m-resposta" maxlength="5000" placeholder="Escreva a resposta..."></textarea></div>
                <button class="btn btn-secundario btn-mini" id="m-btn-responder">Enviar resposta</button>

                <div class="campo" style="margin-top:14px;"><label for="m-interno">Comentário interno (só equipe)</label>
                    <textarea id="m-interno" maxlength="5000" placeholder="Nota interna..."></textarea></div>
                <button class="btn btn-fantasma btn-mini" id="m-btn-interno">Adicionar nota interna</button>
            </div>

            <!-- ABA: TRIAGEM & CLASSIFICAÇÃO -->
            <div class="aba-painel" id="painel-triagem" style="display:none;">
                <div class="triagem-ia">
                    <div class="ia-titulo">⚙ Triagem automática (IA · ${esc(c.analise_ia_versao || '—')})</div>
                    <div class="ia-grid">
                        <div class="ia-item"><div class="ia-rot">Gravidade sugerida</div>${chipGravidade(c.ia_gravidade_sugerida || c.gravidade)}</div>
                        <div class="ia-item"><div class="ia-rot">Confiança</div><div class="val">${c.ia_confianca != null ? Math.round(c.ia_confianca * 100) + '%' : '—'}</div></div>
                        <div class="ia-item"><div class="ia-rot">Categoria sugerida</div><div class="val">${esc(c.categoria_sugerida || '—')}</div></div>
                        <div class="ia-item"><div class="ia-rot">Qualidade descrição</div>
                            <span class="qualidade-tag qual-${esc(c.qualidade_descritiva)}">${c.qualidade_descritiva === 'boa' ? 'Boa' : (c.qualidade_descritiva === 'ruim' ? 'Pode melhorar' : '—')}</span></div>
                    </div>
                    ${c.ia_justificativa ? `<div class="ia-justificativa">"${esc(c.ia_justificativa)}"</div>` : ''}
                </div>

                <div class="linha-campos">
                    <div class="campo"><label>Categoria</label><select id="m-categoria"></select></div>
                    <div class="campo"><label>Subcategoria</label><select id="m-subcategoria"></select></div>
                </div>
                <div class="linha-campos">
                    <div class="campo"><label>Gravidade</label><select id="m-gravidade">${optsGrav}</select></div>
                    <div class="campo"><label>Prioridade</label><select id="m-prioridade">${optsPrio}</select></div>
                </div>
                <div class="linha-campos">
                    <div class="campo"><label>Impacto</label><select id="m-impacto">${optsImp}</select></div>
                    <div class="campo"><label>Responsável</label><select id="m-responsavel">${optsResp}</select></div>
                </div>

                <div class="detalhe-linha" style="margin-top:8px;"><div class="rot">Encerramento (causa raiz / solução / prevenção)</div>
                    <div class="campo"><textarea id="m-causa" placeholder="Causa raiz" style="min-height:60px;">${esc(c.causa_raiz || '')}</textarea></div>
                    <div class="campo"><textarea id="m-solucao" placeholder="Solução aplicada" style="min-height:60px;">${esc(c.solucao_aplicada || '')}</textarea></div>
                    <div class="campo"><textarea id="m-preventiva" placeholder="Ação preventiva" style="min-height:60px;">${esc(c.acao_preventiva || '')}</textarea></div>
                </div>
                <div class="detalhe-linha"><div class="rot">Etiquetas (tags)</div>
                    <div id="m-tags-chips" style="margin-bottom:8px;"></div>
                    <div class="barra-ferramentas">
                        <input type="text" id="m-tag-nova" placeholder="nova etiqueta + Enter" style="width:220px;">
                    </div>
                </div>
            </div>

            <!-- ABA: CONHECIMENTO (similares + KB + promover + mesclar) -->
            <div class="aba-painel" id="painel-conhecimento" style="display:none;">
                <div class="detalhe-linha"><div class="rot">Chamados similares (IA / FTS)</div>
                    <div id="m-similares"><span style="color:var(--cor-texto-suave);">Buscando...</span></div></div>
                <div class="detalhe-linha"><div class="rot">Base de conhecimento</div>
                    <div class="barra-ferramentas" style="margin-bottom:10px;">
                        <input type="search" id="m-kb-busca" placeholder="Buscar artigos...">
                        <button class="btn btn-fantasma btn-mini" id="m-kb-buscar">Buscar</button>
                    </div>
                    <div id="m-kb-resultados"></div></div>
                <div class="detalhe-linha"><div class="rot">Promover este chamado a artigo</div>
                    <div class="campo"><input id="m-art-titulo" placeholder="Título do artigo" value="${esc(c.titulo)}"></div>
                    <div class="campo"><textarea id="m-art-conteudo" placeholder="Solução / passos para resolver..." style="min-height:80px;">${esc(c.solucao_aplicada || '')}</textarea></div>
                    <button class="btn btn-secundario btn-mini" id="m-art-criar">Salvar na base de conhecimento</button></div>
                <div class="detalhe-linha"><div class="rot">Mesclar duplicado</div>
                    <div class="ajuda" style="margin-bottom:8px;">Marca ESTE chamado como duplicado e move tudo para o chamado de destino.</div>
                    <div class="barra-ferramentas">
                        <input type="number" id="m-merge-destino" placeholder="ID do chamado destino" style="width:200px;">
                        <button class="btn btn-fantasma btn-mini" id="m-merge-btn" style="color:var(--grav-alta);border-color:var(--grav-alta);">Mesclar neste</button>
                    </div>
                </div>
            </div>

            <!-- ABA: HISTÓRICO -->
            <div class="aba-painel" id="painel-historico" style="display:none;">
                ${renderTimeline(c.comentarios)}
            </div>

            <div id="modal-alerta" class="alerta" style="margin-top:16px;"></div>`;

        // Troca de abas (todos os campos permanecem no DOM — o salvar continua lendo todos).
        const corpoModal = document.getElementById('modal-corpo');
        corpoModal.querySelectorAll('.aba').forEach(aba => {
            aba.addEventListener('click', () => {
                corpoModal.querySelectorAll('.aba').forEach(x => x.classList.remove('ativa'));
                aba.classList.add('ativa');
                corpoModal.querySelectorAll('.aba-painel').forEach(p => p.style.display = 'none');
                corpoModal.querySelector('#painel-' + aba.dataset.aba).style.display = 'block';
            });
        });

        const selCat = document.getElementById('m-categoria');
        const selSub = document.getElementById('m-subcategoria');
        preencherSelectCategorias(selCat, cats, c.categoria_id);
        preencherSelectSubcategorias(selSub, cats, c.categoria_id, c.subcategoria_id);
        selCat.onchange = () => preencherSelectSubcategorias(selSub, cats, selCat.value);

        // --- Aba Conhecimento: similares, KB e promover a artigo ---
        function renderListaChamados(arr) {
            if (!arr.length) return '<span style="color:var(--cor-texto-suave);">Nenhum encontrado.</span>';
            return arr.map(s => `<div class="kb-item"><span class="similar-link" data-cid="${s.id}">🔗 ${esc(s.numero_protocolo || '#' + s.id)} — ${esc(s.titulo)}</span> ${chipStatus(s.status)}</div>`).join('');
        }
        API.similares(id).then(sim => {
            const el = document.getElementById('m-similares');
            if (el) {
                el.innerHTML = renderListaChamados(sim);
                el.querySelectorAll('.similar-link').forEach(l =>
                    l.addEventListener('click', () => abrirModalAdmin(+l.dataset.cid)));
            }
        }).catch(() => {});

        function renderKb(arr) {
            const el = document.getElementById('m-kb-resultados');
            el.innerHTML = arr.length
                ? arr.map(a => `<div class="kb-item"><div class="kb-titulo">${esc(a.titulo)}</div><div>${esc(a.conteudo)}</div></div>`).join('')
                : '<span style="color:var(--cor-texto-suave);">Nenhum artigo.</span>';
        }
        const fazerBuscaKb = async () => {
            try { renderKb(await API.buscarKb(document.getElementById('m-kb-busca').value.trim())); }
            catch (e) { /* silencioso */ }
        };
        document.getElementById('m-kb-buscar').addEventListener('click', fazerBuscaKb);
        document.getElementById('m-art-criar').addEventListener('click', async () => {
            const titulo = document.getElementById('m-art-titulo').value.trim();
            const conteudo = document.getElementById('m-art-conteudo').value.trim();
            if (titulo.length < 4 || conteudo.length < 10)
                return alertaModal('Informe título e conteúdo do artigo.');
            try {
                await API.promoverArtigo(id, titulo, conteudo);
                alertaModal('Artigo salvo na base de conhecimento.');
                document.getElementById('modal-alerta').className = 'alerta sucesso visivel';
            } catch (e) { alertaModal(e.message); }
        });

        // --- Tags (etiquetas) ---
        let tagsAtuais = [...(c.tags || [])];
        function renderTags() {
            document.getElementById('m-tags-chips').innerHTML = tagsAtuais.length
                ? tagsAtuais.map(t => `<span class="tag-chip">${esc(t)} <span class="x" data-tag="${esc(t)}">×</span></span>`).join('')
                : '<span style="color:var(--cor-texto-suave);font-size:13px;">Sem etiquetas.</span>';
            document.querySelectorAll('#m-tags-chips .x').forEach(x =>
                x.addEventListener('click', () => salvarTags(tagsAtuais.filter(t => t !== x.dataset.tag))));
        }
        async function salvarTags(novas) {
            try { const det = await API.definirTags(id, novas); tagsAtuais = det.tags || []; renderTags(); }
            catch (e) { alertaModal(e.message); }
        }
        renderTags();
        document.getElementById('m-tag-nova').addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const nova = e.target.value.trim().toLowerCase();
                if (nova && !tagsAtuais.includes(nova)) salvarTags([...tagsAtuais, nova]);
                e.target.value = '';
            }
        });

        // --- Mesclar duplicado ---
        document.getElementById('m-merge-btn').addEventListener('click', async () => {
            const destino = parseInt(document.getElementById('m-merge-destino').value, 10);
            if (!destino) return alertaModal('Informe o ID do chamado de destino.');
            if (!confirm(`Mesclar este chamado no #${destino}? Este será cancelado.`)) return;
            try {
                const principal = await API.mesclarChamado(id, destino);
                fecharModal(); carregarGestao();
                abrirModalAdmin(principal.id);
            } catch (e) { alertaModal(e.message); }
        });

        document.getElementById('modal-rodape').innerHTML = `
            <button class="btn btn-fantasma" id="m-cancelar">Fechar</button>
            <button class="btn btn-primario" id="m-salvar">Salvar alterações</button>`;
        document.getElementById('m-cancelar').addEventListener('click', fecharModal);

        document.getElementById('m-btn-responder').addEventListener('click', async () => {
            const txt = document.getElementById('m-resposta').value.trim();
            if (!txt) return;
            try { await API.responderChamado(id, txt); abrirModalAdmin(id); } catch (e) { alertaModal(e.message); }
        });
        document.getElementById('m-btn-interno').addEventListener('click', async () => {
            const txt = document.getElementById('m-interno').value.trim();
            if (!txt) return;
            try { await API.comentarAdmin(id, txt, true); abrirModalAdmin(id); } catch (e) { alertaModal(e.message); }
        });

        document.getElementById('m-salvar').addEventListener('click', async () => {
            const btn = document.getElementById('m-salvar');
            btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Salvando...';
            try {
                const cl = {
                    categoria_id: selCat.value ? +selCat.value : null,
                    subcategoria_id: selSub.value ? +selSub.value : null,
                    gravidade: document.getElementById('m-gravidade').value,
                    prioridade: +document.getElementById('m-prioridade').value,
                    impacto_negocio: document.getElementById('m-impacto').value || null,
                    atribuido_a_id: document.getElementById('m-responsavel').value ? +document.getElementById('m-responsavel').value : null,
                    versao_linha: versao,
                };
                let r = await API.atualizarClassificacao(id, cl);
                versao = r.versao_linha;

                const enc = {
                    causa_raiz: document.getElementById('m-causa').value.trim() || null,
                    solucao_aplicada: document.getElementById('m-solucao').value.trim() || null,
                    acao_preventiva: document.getElementById('m-preventiva').value.trim() || null,
                };
                if (enc.causa_raiz || enc.solucao_aplicada || enc.acao_preventiva) {
                    r = await API.encerramento(id, enc); versao = r.versao_linha;
                }

                const novoStatus = document.getElementById('m-status').value;
                if (novoStatus !== c.status) {
                    r = await API.alterarStatus(id, novoStatus, versao); versao = r.versao_linha;
                }
                fecharModal(); carregarGestao();
            } catch (e) {
                alertaModal(e.message);
                btn.disabled = false; btn.textContent = 'Salvar alterações';
            }
        });

        mostrarModal();
    }

    if (ehAdmin) {
        let debounce;
        const recarregar = () => { paginaGestao = 0; selecionados.clear(); carregarGestao(); };
        const f = document.getElementById('filtro-busca');
        if (f) {
            f.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(recarregar, 350); });
            document.getElementById('filtro-tag').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(recarregar, 350); });
            ['filtro-status', 'filtro-gravidade', 'filtro-categoria', 'filtro-sla', 'filtro-de', 'filtro-ate']
                .forEach(id => document.getElementById(id).addEventListener('change', recarregar));
            document.getElementById('btn-limpar-filtros').addEventListener('click', () => {
                ['filtro-busca', 'filtro-status', 'filtro-gravidade', 'filtro-categoria', 'filtro-sla', 'filtro-tag', 'filtro-de', 'filtro-ate']
                    .forEach(id => document.getElementById(id).value = '');
                recarregar();
            });
            document.getElementById('pg-anterior').addEventListener('click', () => {
                if (paginaGestao > 0) { paginaGestao--; carregarGestao(); }
            });
            document.getElementById('pg-proxima').addEventListener('click', () => {
                paginaGestao++; carregarGestao();
            });
            document.getElementById('btn-exportar').addEventListener('click', async () => {
                try {
                    const blob = await API.baixarCsv();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = 'chamados.csv';
                    document.body.appendChild(a); a.click(); a.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                } catch (e) { alert(e.message); }
            });
            // Popular o filtro de categorias.
            garantirCategorias().then(cats => {
                const sel = document.getElementById('filtro-categoria');
                sel.innerHTML = '<option value="">Todas as categorias</option>'
                    + cats.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
            });
            // Selecionar todos (visíveis).
            document.getElementById('massa-todos').addEventListener('change', e => {
                document.querySelectorAll('.chk-massa').forEach(chk => {
                    chk.checked = e.target.checked;
                    if (e.target.checked) selecionados.add(+chk.value); else selecionados.delete(+chk.value);
                });
                atualizarBarraMassa();
            });
            // Ação em massa: ajusta os controles conforme a ação.
            const mAcao = document.getElementById('massa-acao');
            const mValor = document.getElementById('massa-valor');
            const mMotivo = document.getElementById('massa-motivo');
            mAcao.addEventListener('change', async () => {
                mValor.style.display = 'none'; mMotivo.style.display = 'none';
                if (mAcao.value === 'atribuir') {
                    const eq = await garantirUsuarios();
                    mValor.innerHTML = '<option value="">— sem responsável —</option>'
                        + eq.filter(u => (RANK[u.papel] || 1) >= RANK.analista)
                            .map(u => `<option value="${u.id}">${esc(u.nome)}</option>`).join('');
                    mValor.style.display = '';
                } else if (mAcao.value === 'status') {
                    mValor.innerHTML = ['em_andamento', 'aguardando_usuario', 'resolvido', 'fechado']
                        .map(s => `<option value="${s}">${ROTULO_STATUS[s]}</option>`).join('');
                    mValor.style.display = '';
                } else if (mAcao.value === 'cancelar') {
                    mMotivo.style.display = '';
                }
            });
            document.getElementById('massa-aplicar').addEventListener('click', async () => {
                const acao = mAcao.value;
                if (!acao) return alert('Escolha uma ação.');
                if (!selecionados.size) return alert('Nenhum chamado selecionado.');
                const ids = [...selecionados];
                let valor = null, motivo = null;
                if (acao === 'atribuir' || acao === 'status') valor = mValor.value;
                if (acao === 'cancelar') {
                    motivo = (mMotivo.value || '').trim();
                    if (motivo.length < 5) return alert('Informe um motivo (mín. 5 caracteres).');
                    if (!confirm(`Cancelar ${ids.length} chamado(s)?`)) return;
                }
                try {
                    const r = await API.acaoMassa(ids, acao, valor, motivo);
                    alert(`Aplicado a ${r.aplicados} chamado(s).` + (r.pulados ? ` ${r.pulados} pulado(s) por transição inválida.` : ''));
                    selecionados.clear(); mAcao.value = ''; mValor.style.display = 'none'; mMotivo.style.display = 'none';
                    carregarGestao();
                } catch (e) { alert(e.message); }
            });
        }
        const btnImp = document.getElementById('btn-imprimir');
        if (btnImp) btnImp.addEventListener('click', () => window.print());
    }

    // ================================================================== //
    // KANBAN (admin) — arrastar cartões entre colunas muda o status
    // ================================================================== //
    const KANBAN_COLUNAS = [
        { status: 'aberto', titulo: 'Aberto' },
        { status: 'em_andamento', titulo: 'Em andamento' },
        { status: 'aguardando_usuario', titulo: 'Aguardando usuário' },
        { status: 'resolvido', titulo: 'Resolvido' },
    ];

    async function carregarKanban() {
        const board = document.getElementById('kanban-board');
        board.innerHTML = '<div style="padding:20px;color:var(--cor-texto-suave);">Carregando...</div>';
        let chamados;
        try { chamados = await API.todosChamados({ limite: 500 }); }
        catch (e) { board.innerHTML = `<div style="padding:20px;color:#b3261e;">${esc(e.message)}</div>`; return; }

        const porStatus = {};
        KANBAN_COLUNAS.forEach(col => porStatus[col.status] = []);
        chamados.forEach(c => { if (porStatus[c.status]) porStatus[c.status].push(c); });

        board.innerHTML = '';
        KANBAN_COLUNAS.forEach(col => {
            const lista = porStatus[col.status];
            const coluna = document.createElement('div');
            coluna.className = 'kanban-coluna';
            coluna.dataset.status = col.status;
            coluna.innerHTML = `<h4>${esc(col.titulo)} <span class="qtd">${lista.length}</span></h4>`;
            lista.forEach(c => coluna.appendChild(criarCardKanban(c)));

            // Alvos de drop.
            coluna.addEventListener('dragover', e => { e.preventDefault(); coluna.classList.add('alvo'); });
            coluna.addEventListener('dragleave', () => coluna.classList.remove('alvo'));
            coluna.addEventListener('drop', async e => {
                e.preventDefault();
                coluna.classList.remove('alvo');
                const dados = JSON.parse(e.dataTransfer.getData('text/plain') || '{}');
                if (!dados.id || dados.status === col.status) return;
                try {
                    await API.alterarStatus(dados.id, col.status, dados.versao);
                    carregarKanban();
                } catch (err) {
                    alert(err.message);
                    carregarKanban();
                }
            });
            board.appendChild(coluna);
        });
    }

    function criarCardKanban(c) {
        const card = document.createElement('div');
        card.className = 'kanban-card';
        card.draggable = true;
        card.innerHTML = `
            <div class="kc-topo">
                <span class="kc-proto">${esc(c.numero_protocolo || '#' + c.id)}</span>
                ${chipPrioridade(c.prioridade)}
            </div>
            <div class="kc-titulo">${esc(c.titulo)}</div>
            <div class="kc-rodape">
                ${chipGravidade(c.gravidade)}
                ${chipSla(c.sla_status)}
            </div>`;
        card.addEventListener('dragstart', e => {
            card.classList.add('arrastando');
            e.dataTransfer.setData('text/plain', JSON.stringify({
                id: c.id, versao: c.versao_linha, status: c.status,
            }));
        });
        card.addEventListener('dragend', () => card.classList.remove('arrastando'));
        // Clique abre o popup com todas as informações + descrição.
        card.addEventListener('click', () => abrirModalAdmin(c.id));
        return card;
    }

    // ================================================================== //
    // GESTÃO DE USUÁRIOS (admin)
    // ================================================================== //
    async function carregarUsuarios() {
        const corpo = document.getElementById('corpo-usuarios');
        corpo.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;">Carregando...</td></tr>`;
        try {
            usuariosCache = await API.usuarios();
            const mapa = {}; usuariosCache.forEach(u => mapa[u.id] = u.nome);
            corpo.innerHTML = '';
            usuariosCache.forEach(u => {
                const tr = document.createElement('tr');
                const situacao = u.ativo
                    ? '<span class="sla-chip sla-ok">Ativo</span>'
                    : '<span class="sla-chip sla-em_risco">Pendente</span>';
                tr.innerHTML = `
                    <td><strong>${esc(u.nome)}</strong></td>
                    <td>${esc(u.matricula)}</td>
                    <td>${esc(ROTULO_PAPEL[u.papel] || u.papel)}</td>
                    <td>${u.supervisor_id ? esc(mapa[u.supervisor_id] || '—') : '—'}</td>
                    <td>${esc(u.unidade_setor || '—')}</td>
                    <td>${situacao}</td>
                    <td style="display:flex;gap:6px;">
                        ${!u.ativo ? '<button class="btn-mini btn-aprovar">✓ Aprovar</button>' : ''}
                        <button class="btn-mini btn-editar">Editar</button>
                        ${u.id !== usuario.id ? '<button class="btn-mini btn-excluir-user" style="background:var(--grav-critica-bg);color:var(--grav-critica);">Excluir</button>' : ''}
                    </td>`;
                tr.querySelector('.btn-editar').addEventListener('click', () => abrirModalUsuarioAdmin(u));
                const ap = tr.querySelector('.btn-aprovar');
                if (ap) ap.addEventListener('click', async () => {
                    if (!confirm(`Aprovar o acesso de ${u.nome}?`)) return;
                    try { await API.atualizarUsuario(u.id, { ativo: true }); carregarUsuarios(); }
                    catch (e) { alert(e.message); }
                });
                const ex = tr.querySelector('.btn-excluir-user');
                if (ex) ex.addEventListener('click', async () => {
                    if (!confirm(`Excluir o usuário "${u.nome}"?\n\nSe ele tiver histórico (chamados, comentários, auditoria), será anonimizado e desativado em vez de apagado — para preservar a trilha.`)) return;
                    try {
                        const r = await API.excluirUsuario(u.id);
                        alert(r.detail || 'Usuário removido.');
                        carregarUsuarios();
                    } catch (e) { alert(e.message); }
                });
                corpo.appendChild(tr);
            });
        } catch (e) {
            corpo.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#b3261e;">${esc(e.message)}</td></tr>`;
        }
    }

    // Árvore hierárquica do usuário: a cadeia de chefias acima + os subordinados
    // diretos. Montada a partir do usuariosCache (cada um tem supervisor_id).
    function renderArvoreHierarquia(u) {
        const byId = {}; usuariosCache.forEach(x => byId[x.id] = x);
        const acima = []; const visto = new Set();
        let cur = u.supervisor_id ? byId[u.supervisor_id] : null;
        while (cur && !visto.has(cur.id)) { acima.unshift(cur); visto.add(cur.id); cur = cur.supervisor_id ? byId[cur.supervisor_id] : null; }
        const filhos = usuariosCache.filter(x => x.supervisor_id === u.id);
        const no = (x, cls, nivel) => `
            <div class="arvore-no ${cls}" style="margin-left:${nivel * 22}px">
                <span class="arvore-papel">${esc(ROTULO_PAPEL[x.papel] || x.papel)}</span>
                <strong>${esc(x.nome)}</strong>
                ${x.unidade_setor ? `<span class="arvore-setor">${esc(x.unidade_setor)}</span>` : ''}
            </div>`;
        let html = acima.map((x, i) => no(x, '', i)).join('');
        html += no(u, 'arvore-atual', acima.length);
        html += filhos.length
            ? filhos.map(f => no(f, 'arvore-filho', acima.length + 1)).join('')
            : `<div class="arvore-vazio" style="margin-left:${(acima.length + 1) * 22}px">Sem subordinados diretos.</div>`;
        return `<div class="detalhe-linha" style="margin-top:18px;">
            <div class="rot">Árvore hierárquica</div><div class="arvore">${html}</div></div>`;
    }

    function abrirModalUsuarioAdmin(u) {
        const edicao = !!u;
        document.getElementById('modal-titulo').textContent = edicao ? `Editar — ${u.nome}` : 'Novo usuário';
        const papeis = ['colaborador', 'analista', 'lider', 'coordenador', 'administrador'];
        const optsPapel = papeis.map(p => `<option value="${p}" ${edicao && u.papel === p ? 'selected' : ''}>${ROTULO_PAPEL[p]}</option>`).join('');
        const optsSup = ['<option value="">— nenhum —</option>'].concat(
            usuariosCache.filter(x => !edicao || x.id !== u.id)
                .map(x => `<option value="${x.id}" ${edicao && u.supervisor_id === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`)
        ).join('');

        document.getElementById('modal-corpo').innerHTML = `
            <div class="campo"><label>Nome</label><input id="u-nome" value="${edicao ? esc(u.nome) : ''}"></div>
            <div class="linha-campos">
                <div class="campo"><label>Matrícula</label><input id="u-matricula" value="${edicao ? esc(u.matricula) : ''}" ${edicao ? 'disabled' : ''}></div>
                <div class="campo"><label>${edicao ? 'Redefinir senha (opcional)' : 'Senha'}</label><input id="u-senha" type="password" autocomplete="new-password" placeholder="${edicao ? 'Deixe em branco para manter a atual' : ''}">${edicao ? '<div class="ajuda">Se preencher, o usuário troca no próximo acesso.</div>' : ''}</div>
            </div>
            <div class="linha-campos">
                <div class="campo"><label>Papel</label><select id="u-papel">${optsPapel}</select></div>
                <div class="campo"><label>Supervisor</label><select id="u-supervisor">${optsSup}</select></div>
            </div>
            <div class="linha-campos">
                <div class="campo"><label>Setor</label><input id="u-setor" value="${edicao ? esc(u.unidade_setor || '') : ''}"></div>
                <div class="campo"><label>E-mail</label><input id="u-email" value="${edicao ? esc(u.email || '') : ''}"></div>
            </div>
            <div class="linha-campos">
                <div class="campo"><label>Ramal</label><input id="u-ramal" value="${edicao ? esc(u.ramal || '') : ''}"></div>
                ${edicao ? `<div class="campo"><label>Situação</label><select id="u-ativo">
                    <option value="1" ${u.ativo ? 'selected' : ''}>Ativo</option>
                    <option value="0" ${!u.ativo ? 'selected' : ''}>Inativo</option></select></div>` : '<div></div>'}
            </div>
            <div class="ajuda">Trocar papel, desativar ou redefinir senha encerra as sessões abertas do usuário imediatamente.</div>
            ${edicao ? renderArvoreHierarquia(u) : ''}
            <div id="modal-alerta" class="alerta" style="margin-top:12px;"></div>`;

        document.getElementById('modal-rodape').innerHTML = `
            <button class="btn btn-fantasma" id="u-cancelar">Cancelar</button>
            <button class="btn btn-primario" id="u-salvar">${edicao ? 'Salvar' : 'Criar usuário'}</button>`;
        document.getElementById('u-cancelar').addEventListener('click', fecharModal);
        document.getElementById('u-salvar').addEventListener('click', async () => {
            const v = id => (document.getElementById(id) ? document.getElementById(id).value.trim() : '');
            const dados = {
                nome: v('u-nome'), papel: v('u-papel'),
                supervisor_id: v('u-supervisor') ? +v('u-supervisor') : null,
                unidade_setor: v('u-setor') || null, email: v('u-email') || null, ramal: v('u-ramal') || null,
            };
            const btn = document.getElementById('u-salvar');
            btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Salvando...';
            try {
                if (edicao) {
                    if (v('u-senha')) dados.nova_senha = v('u-senha');
                    dados.ativo = v('u-ativo') === '1';
                    await API.atualizarUsuario(u.id, dados);
                } else {
                    dados.matricula = v('u-matricula'); dados.senha = v('u-senha');
                    await API.criarUsuario(dados);
                }
                fecharModal(); carregarUsuarios();
            } catch (e) {
                alertaModal(e.message);
                btn.disabled = false; btn.textContent = edicao ? 'Salvar' : 'Criar usuário';
            }
        });
        mostrarModal();
    }

    if (ehAdmin) {
        const b = document.getElementById('btn-novo-usuario');
        if (b) b.addEventListener('click', async () => { await garantirUsuarios(); abrirModalUsuarioAdmin(null); });
        const br = document.getElementById('btn-reset-db');
        if (br) br.addEventListener('click', abrirModalReset);
        const bl = document.getElementById('btn-limpar-dados');
        if (bl) bl.addEventListener('click', abrirModalLimpar);
    }

    function abrirModalLimpar() {
        document.getElementById('modal-titulo').textContent = '🧹 Limpar dados de movimento';
        document.getElementById('modal-corpo').innerHTML = `
            <div class="alerta erro visivel" style="display:block;">
                Apaga <strong>chamados, comentários, anexos, avaliações, notificações,
                auditoria e etiquetas</strong>. É <strong>irreversível</strong>.
            </div>
            <p class="ajuda" style="margin-bottom:16px;">
                <strong>Preserva</strong> todos os usuários e a configuração (categorias,
                SLA, feriados, modelos e base de conhecimento). <strong>Não</strong> roda o seed.
                Para confirmar, digite <strong>sua</strong> matrícula e senha de administrador.
            </p>
            <div class="campo"><label>Matrícula</label><input id="lmp-matricula" autocomplete="off"></div>
            <div class="campo"><label>Senha</label><input id="lmp-senha" type="password" autocomplete="off"></div>
            <div id="modal-alerta" class="alerta"></div>`;
        document.getElementById('modal-rodape').innerHTML = `
            <button class="btn btn-fantasma" id="lmp-cancelar">Cancelar</button>
            <button class="btn btn-perigo" id="lmp-confirmar">Limpar dados</button>`;
        document.getElementById('lmp-cancelar').addEventListener('click', fecharModal);
        document.getElementById('lmp-confirmar').addEventListener('click', async () => {
            const mat = document.getElementById('lmp-matricula').value.trim();
            const sen = document.getElementById('lmp-senha').value;
            if (!mat || !sen) return alertaModal('Informe matrícula e senha.');
            const btn = document.getElementById('lmp-confirmar');
            btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Limpando...';
            try {
                const r = await API.limparDados(mat, sen);
                fecharModal();
                alert(r.detail || 'Dados de movimento apagados. Usuários e configuração preservados.');
                if (typeof carregarUsuarios === 'function') carregarUsuarios();
            } catch (e) {
                alertaModal(e.message);
                btn.disabled = false; btn.textContent = 'Limpar dados';
            }
        });
        mostrarModal();
    }

    function abrirModalReset() {
        document.getElementById('modal-titulo').textContent = '⚠ Resetar banco de dados';
        document.getElementById('modal-corpo').innerHTML = `
            <div class="alerta erro visivel" style="display:block;">
                Esta ação <strong>APAGA todos os chamados, comentários, avaliações e usuários</strong>
                e recria os dados de exemplo (seed). É <strong>irreversível</strong>.
            </div>
            <p class="ajuda" style="margin-bottom:16px;">
                Para confirmar, digite novamente <strong>sua</strong> matrícula e senha de administrador.
            </p>
            <div class="campo"><label>Matrícula</label><input id="rst-matricula" autocomplete="off"></div>
            <div class="campo"><label>Senha</label><input id="rst-senha" type="password" autocomplete="off"></div>
            <div id="modal-alerta" class="alerta"></div>`;
        document.getElementById('modal-rodape').innerHTML = `
            <button class="btn btn-fantasma" id="rst-cancelar">Cancelar</button>
            <button class="btn btn-perigo" id="rst-confirmar">Apagar e resetar</button>`;
        document.getElementById('rst-cancelar').addEventListener('click', fecharModal);
        document.getElementById('rst-confirmar').addEventListener('click', async () => {
            const mat = document.getElementById('rst-matricula').value.trim();
            const sen = document.getElementById('rst-senha').value;
            if (!mat || !sen) return alertaModal('Informe matrícula e senha.');
            const btn = document.getElementById('rst-confirmar');
            btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Resetando...';
            try {
                await API.resetDb(mat, sen);
                alert('Banco resetado. Você será redirecionado ao login (credenciais de seed restauradas).');
                API.sair();
            } catch (e) {
                alertaModal(e.message);
                btn.disabled = false; btn.textContent = 'Apagar e resetar';
            }
        });
        mostrarModal();
    }

    // ================================================================== //
    // AUDITORIA (admin)
    // ================================================================== //
    async function carregarAuditoria() {
        const corpo = document.getElementById('corpo-auditoria');
        corpo.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;">Carregando...</td></tr>`;
        try {
            const eventos = await API.auditoria();
            corpo.innerHTML = '';
            eventos.forEach(e => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${formatarData(e.criado_em)}</td>
                    <td>${esc(e.usuario || '—')}</td>
                    <td><strong>${esc(e.acao)}</strong></td>
                    <td>${esc(e.entidade || '')}${e.entidade_id ? ' #' + e.entidade_id : ''}</td>
                    <td style="max-width:280px;font-size:13px;color:var(--cor-texto-suave);">${esc(e.detalhe || '')}</td>
                    <td>${esc(e.ip || '')}</td>`;
                corpo.appendChild(tr);
            });
        } catch (e) {
            corpo.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:#b3261e;">${esc(e.message)}</td></tr>`;
        }
    }

    // ================================================================== //
    // BASE DE CONHECIMENTO (todos leem; admin gerencia)
    // ================================================================== //
    async function carregarKb() {
        const lista = document.getElementById('kb-lista');
        const btnNovo = document.getElementById('btn-novo-artigo');
        if (btnNovo) btnNovo.style.display = ehAdmin ? '' : 'none';
        lista.innerHTML = '<div class="kb-vazio">Carregando...</div>';
        try {
            const termo = document.getElementById('kb-busca').value.trim();
            const artigos = await API.kbListar(termo);
            if (!artigos.length) { lista.innerHTML = '<div class="kb-vazio">Nenhum artigo encontrado.</div>'; return; }
            lista.innerHTML = artigos.map(a => `
                <div class="kb-item" data-id="${a.id}">
                    <div class="kb-titulo">📚 ${esc(a.titulo)}</div>
                    <div style="color:var(--cor-texto-suave);font-size:13px;">${esc((a.conteudo || '').slice(0, 140))}${(a.conteudo || '').length > 140 ? '…' : ''}</div>
                </div>`).join('');
            lista.querySelectorAll('.kb-item').forEach(el =>
                el.addEventListener('click', () => abrirArtigo(+el.dataset.id)));
        } catch (e) {
            lista.innerHTML = `<div class="kb-vazio" style="color:#b3261e;">${esc(e.message)}</div>`;
        }
    }

    async function abrirArtigo(id) {
        let a;
        try { a = await API.kbDetalhe(id); } catch (e) { return alert(e.message); }
        document.getElementById('modal-titulo').textContent = a.titulo;
        document.getElementById('modal-corpo').innerHTML = `
            <div class="detalhe-descricao">${esc(a.conteudo)}</div>
            ${a.chamado_origem_id ? `<div class="ajuda" style="margin-top:10px;">Origem: chamado #${a.chamado_origem_id}</div>` : ''}
            <div class="detalhe-linha" style="margin-top:16px;">
                <div class="rot">Isso resolveu seu problema?</div>
                <div class="voto-kb">
                    <button class="voto-btn ${a.meu_voto === true ? 'ativo' : ''}" id="voto-sim">👍 <span id="voto-uteis">${a.uteis}</span></button>
                    <button class="voto-btn ${a.meu_voto === false ? 'ativo' : ''}" id="voto-nao">👎 <span id="voto-naouteis">${a.nao_uteis}</span></button>
                </div>
            </div>
            <div id="modal-alerta" class="alerta"></div>`;
        document.getElementById('modal-rodape').innerHTML = ehAdmin
            ? `<button class="btn btn-perigo btn-mini" id="art-excluir">Excluir</button>
               <span class="espaco-flex"></span>
               <button class="btn btn-fantasma" id="art-fechar">Fechar</button>
               <button class="btn btn-primario" id="art-editar">Editar</button>`
            : `<button class="btn btn-secundario" id="art-fechar">Fechar</button>`;
        document.getElementById('art-fechar').addEventListener('click', fecharModal);
        async function votar(util) {
            try {
                const r = await API.kbVotar(id, util);
                document.getElementById('voto-uteis').textContent = r.uteis;
                document.getElementById('voto-naouteis').textContent = r.nao_uteis;
                document.getElementById('voto-sim').classList.toggle('ativo', r.meu_voto === true);
                document.getElementById('voto-nao').classList.toggle('ativo', r.meu_voto === false);
            } catch (e) { alertaModal(e.message); }
        }
        document.getElementById('voto-sim').addEventListener('click', () => votar(true));
        document.getElementById('voto-nao').addEventListener('click', () => votar(false));
        if (ehAdmin) {
            document.getElementById('art-editar').addEventListener('click', () => abrirEditorArtigo(a));
            document.getElementById('art-excluir').addEventListener('click', async () => {
                if (!confirm('Excluir este artigo?')) return;
                try { await API.kbExcluir(id); fecharModal(); carregarKb(); } catch (e) { alertaModal(e.message); }
            });
        }
        mostrarModal();
    }

    function abrirEditorArtigo(artigo) {
        const ed = !!artigo;
        document.getElementById('modal-titulo').textContent = ed ? 'Editar artigo' : 'Novo artigo';
        document.getElementById('modal-corpo').innerHTML = `
            <div class="campo"><label>Título</label><input id="art-titulo" value="${ed ? esc(artigo.titulo) : ''}"></div>
            <div class="campo"><label>Conteúdo</label><textarea id="art-conteudo" style="min-height:160px;">${ed ? esc(artigo.conteudo) : ''}</textarea></div>
            <div id="modal-alerta" class="alerta"></div>`;
        document.getElementById('modal-rodape').innerHTML = `
            <button class="btn btn-fantasma" id="art-cancelar">Cancelar</button>
            <button class="btn btn-primario" id="art-salvar">Salvar</button>`;
        document.getElementById('art-cancelar').addEventListener('click', fecharModal);
        document.getElementById('art-salvar').addEventListener('click', async () => {
            const titulo = document.getElementById('art-titulo').value.trim();
            const conteudo = document.getElementById('art-conteudo').value.trim();
            if (titulo.length < 4 || conteudo.length < 10) return alertaModal('Título (4+) e conteúdo (10+) obrigatórios.');
            try {
                if (ed) await API.kbAtualizar(artigo.id, { titulo, conteudo });
                else await API.kbCriar(titulo, conteudo);
                fecharModal(); carregarKb();
            } catch (e) { alertaModal(e.message); }
        });
        mostrarModal();
    }

    {
        const b = document.getElementById('kb-buscar');
        if (b) b.addEventListener('click', carregarKb);
        const s = document.getElementById('kb-busca');
        if (s) s.addEventListener('keydown', e => { if (e.key === 'Enter') carregarKb(); });
        const n = document.getElementById('btn-novo-artigo');
        if (n) n.addEventListener('click', () => abrirEditorArtigo(null));
    }

    // ================================================================== //
    // DASHBOARD
    // ================================================================== //
    const graficos = {};
    // Lê cores do tema vigente (recalculado a cada render p/ acompanhar claro/escuro).
    function tema() {
        const cs = getComputedStyle(document.documentElement);
        const v = n => cs.getPropertyValue(n).trim();
        return {
            primaria: v('--cor-primaria') || '#800000',
            texto: v('--cor-texto-suave') || '#7c6d72',
            grid: (v('--cor-borda') || '#ece5e7'),
            card: v('--cor-card') || '#fff',
        };
    }
    const COR = {
        gravidade: { 'Baixa': '#1f9d66', 'Média': '#cf9a1a', 'Alta': '#e07a1f', 'Crítica': '#d6362c' },
        status: {
            aberto: '#9a2d3a', em_andamento: '#cf9a1a', aguardando_usuario: '#7e6bb0',
            resolvido: '#1f9d66', fechado: '#8a8a93', reaberto: '#e07a1f', cancelado: '#b0a6aa',
        },
        sla: { ok: '#1f9d66', em_risco: '#e07a1f', vencido: '#d6362c' },
        prioridade: ['#c9c2c4', '#1f9d66', '#cf9a1a', '#e07a1f', '#d6362c'],
        aging: ['#1f9d66', '#cf9a1a', '#e07a1f', '#d6362c'],
    };
    function destruir(k) { if (graficos[k]) { graficos[k].destroy(); delete graficos[k]; } }

    function opcoesBase() {
        const t = tema();
        return {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { labels: { color: t.texto, font: { family: 'Segoe UI', size: 12 }, usePointStyle: true, pointStyle: 'circle', padding: 16 } },
                tooltip: {
                    backgroundColor: t.card, titleColor: t.texto, bodyColor: t.texto,
                    borderColor: t.grid, borderWidth: 1, cornerRadius: 10,
                    padding: { top: 10, bottom: 10, left: 14, right: 14 },
                    displayColors: false,          // sem o quadradinho de cor (declutter)
                    caretPadding: 8, caretSize: 7,  // afasta o balão da barra
                    yAlign: 'bottom',               // sempre acima do ponto, não sobrepondo
                    titleFont: { family: 'Segoe UI', weight: '700', size: 13 },
                    bodyFont: { family: 'Segoe UI', size: 13 },
                    callbacks: {
                        // Texto claro no balão: "N chamado(s)" em vez de um número solto.
                        label: (ctx) => {
                            const v = (ctx.parsed && typeof ctx.parsed === 'object')
                                ? ctx.parsed.y : ctx.parsed;
                            return `${v} ${v === 1 ? 'chamado' : 'chamados'}`;
                        },
                    },
                },
            },
        };
    }
    function opcoesBarra(horizontal) {
        const t = tema();
        const base = opcoesBase();
        const eixoValor = {
            beginAtZero: true, grid: { color: t.grid, drawTicks: false },
            border: { display: false }, ticks: { color: t.texto, precision: 0, padding: 8 },
        };
        const eixoCategoria = {
            grid: { display: false }, border: { display: false },
            ticks: { color: t.texto, font: { size: 12 }, autoSkip: false },
        };
        return {
            ...base,
            indexAxis: horizontal ? 'y' : 'x',
            plugins: { ...base.plugins, legend: { display: false } },
            scales: horizontal
                ? { x: eixoValor, y: eixoCategoria }
                : { x: eixoCategoria, y: eixoValor },
        };
    }

    async function carregarDashboard() {
        let d;
        try { d = await API.dashboard(); } catch (e) { console.error(e); return; }
        document.getElementById('kpi-abertos').textContent = d.abertos;
        document.getElementById('kpi-resolvidos').textContent = d.resolvidos;
        document.getElementById('kpi-criticos').textContent = d.por_gravidade['Crítica'] || 0;
        document.getElementById('kpi-tempo').textContent =
            d.tempo_medio_resolucao_horas !== null ? `${d.tempo_medio_resolucao_horas} h` : 'Sem dados';
        document.getElementById('kpi-sla').textContent = `${d.sla.vencido} / ${d.sla.em_risco}`;
        document.getElementById('kpi-csat').textContent =
            d.csat_medio !== null ? `${d.csat_medio} ★` : 'Sem dados';
        document.getElementById('kpi-sla-cumprido').textContent =
            d.sla_cumprimento !== null && d.sla_cumprimento !== undefined ? `${d.sla_cumprimento}%` : 'Sem dados';
        document.getElementById('kpi-deflexoes').textContent = d.deflexoes ?? 0;

        const gl = ['Baixa', 'Média', 'Alta', 'Crítica'];
        desenharDoughnut('gravidade', 'g-gravidade', gl, gl.map(l => d.por_gravidade[l] || 0), gl.map(l => COR.gravidade[l]));
        const stKeys = Object.keys(d.por_status);
        desenharBarra('status', 'g-status', stKeys.map(k => ROTULO_STATUS[k] || k),
            stKeys.map(k => d.por_status[k]), stKeys.map(k => COR.status[k] || '#9a2d3a'), true);
        desenharBarra('prioridade', 'g-prioridade', ['P1', 'P2', 'P3', 'P4', 'P5'],
            ['1', '2', '3', '4', '5'].map(p => d.por_prioridade[p] || 0), COR.prioridade);
        desenharBarra('aging', 'g-aging', ['0-4h', '4-24h', '1-3d', '>3d'],
            ['0-4h', '4-24h', '1-3d', '>3d'].map(k => d.aging[k] || 0), COR.aging);
        desenharDoughnut('sla', 'g-sla', ['No prazo', 'Em risco', 'Vencido'],
            [d.sla.ok, d.sla.em_risco, d.sla.vencido], [COR.sla.ok, COR.sla.em_risco, COR.sla.vencido]);
        const wl = d.workload || {};
        desenharBarra('workload', 'g-workload', Object.keys(wl), Object.values(wl), '#9a3b48');

        const ca = d.csat_por_analista || {};
        desenharBarraCsat('csatA', 'g-csat-analista', Object.keys(ca), Object.values(ca));
        const cc = d.csat_por_categoria || {};
        desenharBarraCsat('csatC', 'g-csat-categoria', Object.keys(cc), Object.values(cc));

        desenharVolume(d.volume_ultimos_dias);
    }

    // CSAT: barra horizontal com escala fixa 0–5 (média de estrelas).
    function desenharBarraCsat(chave, canvasId, labels, dados) {
        destruir(chave);
        if (!labels.length) {
            const ctx = document.getElementById(canvasId).getContext('2d');
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            return;
        }
        const opts = opcoesBarra(true);
        opts.scales.x.max = 5;
        // Tooltip específico de CSAT: "4.5 ★ (média)" em vez de "N chamados".
        opts.plugins.tooltip.callbacks = {
            label: (ctx) => {
                const v = (ctx.parsed && typeof ctx.parsed === 'object') ? ctx.parsed.x : ctx.parsed;
                return `${v} ★ (média)`;
            },
        };
        graficos[chave] = new Chart(document.getElementById(canvasId), {
            type: 'bar',
            data: { labels, datasets: [{ data: dados, backgroundColor: '#cf9a1a',
                borderRadius: 8, maxBarThickness: 22, borderSkipped: false }] },
            options: opts,
        });
    }

    function desenharDoughnut(chave, canvasId, labels, dados, cores) {
        destruir(chave);
        const t = tema();
        graficos[chave] = new Chart(document.getElementById(canvasId), {
            type: 'doughnut',
            data: { labels, datasets: [{ data: dados, backgroundColor: cores,
                borderWidth: 3, borderColor: t.card, hoverOffset: 8, spacing: 2 }] },
            options: { ...opcoesBase(), cutout: '68%',
                plugins: { ...opcoesBase().plugins, legend: { ...opcoesBase().plugins.legend, position: 'bottom' } } },
        });
    }
    function desenharBarra(chave, canvasId, labels, dados, cor, horizontal) {
        destruir(chave);
        graficos[chave] = new Chart(document.getElementById(canvasId), {
            type: 'bar',
            data: { labels, datasets: [{ data: dados, backgroundColor: cor,
                borderRadius: 8, maxBarThickness: horizontal ? 26 : 46, borderSkipped: false }] },
            options: opcoesBarra(horizontal),
        });
    }
    function desenharVolume(volume) {
        destruir('volume');
        const t = tema();
        const labels = (volume || []).map(v => { const [, m, dia] = v.data.split('-'); return `${dia}/${m}`; });
        const ctx = document.getElementById('g-volume').getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 0, 280);
        grad.addColorStop(0, 'rgba(128,0,0,0.22)');
        grad.addColorStop(1, 'rgba(128,0,0,0.01)');
        graficos.volume = new Chart(document.getElementById('g-volume'), {
            type: 'line',
            data: { labels, datasets: [{ label: 'Chamados', data: (volume || []).map(v => v.total),
                borderColor: t.primaria, backgroundColor: grad, borderWidth: 2,
                fill: true,
                // 'monotone' impede a curva de "estourar" abaixo/acima dos pontos.
                cubicInterpolationMode: 'monotone', tension: 0,
                pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: t.primaria }] },
            options: opcoesBarra(),
        });
    }

    // ================================================================== //
    // MODAL (genérico)
    // ================================================================== //
    const $modalFundo = document.getElementById('modal-fundo');
    let senhaObrigatoria = false;  // bloqueia o fechamento na troca forçada
    function mostrarModal() { $modalFundo.classList.add('visivel'); }
    function fecharModal() { if (!senhaObrigatoria) $modalFundo.classList.remove('visivel'); }
    document.getElementById('modal-fechar').addEventListener('click', fecharModal);
    $modalFundo.addEventListener('click', e => { if (e.target === $modalFundo) fecharModal(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharModal(); });

    // ================================================================== //
    // TROCA DE SENHA (obrigatória no 1º acesso, ou voluntária)
    // ================================================================== //
    function abrirTrocaSenha(obrigatoria) {
        senhaObrigatoria = !!obrigatoria;
        document.getElementById('modal-titulo').textContent =
            obrigatoria ? '🔒 Defina uma nova senha' : 'Trocar senha';
        document.getElementById('modal-fechar').style.display = obrigatoria ? 'none' : '';
        document.getElementById('modal-corpo').innerHTML = `
            ${obrigatoria ? '<div class="alerta erro visivel" style="display:block;">Sua senha é provisória. Defina uma nova senha para continuar.</div>' : ''}
            <div class="campo"><label>Senha atual</label><input id="ts-atual" type="password" autocomplete="current-password"></div>
            <div class="campo"><label>Nova senha</label><input id="ts-nova" type="password" autocomplete="new-password"></div>
            <div class="ajuda">Mínimo 8 caracteres, com maiúscula, minúscula, número e símbolo.</div>
            <div class="campo"><label>Confirmar nova senha</label><input id="ts-conf" type="password" autocomplete="new-password"></div>
            <div id="modal-alerta" class="alerta"></div>`;
        document.getElementById('modal-rodape').innerHTML =
            `${obrigatoria ? '' : '<button class="btn btn-fantasma" id="ts-cancelar">Cancelar</button>'}
             <button class="btn btn-primario" id="ts-salvar">Salvar senha</button>`;
        const cancelar = document.getElementById('ts-cancelar');
        if (cancelar) cancelar.addEventListener('click', fecharModal);
        document.getElementById('ts-salvar').addEventListener('click', async () => {
            const atual = document.getElementById('ts-atual').value;
            const nova = document.getElementById('ts-nova').value;
            const conf = document.getElementById('ts-conf').value;
            if (nova !== conf) return alertaModal('A confirmação não confere.');
            const btn = document.getElementById('ts-salvar');
            btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Salvando...';
            try {
                await API.trocarSenha(atual, nova);
                API.marcarSenhaTrocada();
                senhaObrigatoria = false;
                document.getElementById('modal-fechar').style.display = '';
                fecharModal();
            } catch (e) {
                alertaModal(e.message);
                btn.disabled = false; btn.textContent = 'Salvar senha';
            }
        });
        mostrarModal();
    }

    // ================================================================== //
    // SININHO DE NOTIFICAÇÕES
    // ================================================================== //
    function initSino() {
        const $sino = document.getElementById('btn-sino');
        const $painel = document.getElementById('sino-painel');
        const $badge = document.getElementById('sino-badge');
        const $lista = document.getElementById('sino-lista');

        async function atualizarBadge() {
            try {
                const { nao_lidas } = await API.notifContagem();
                $badge.textContent = nao_lidas;
                $badge.style.display = nao_lidas ? '' : 'none';
            } catch (e) { /* silencioso */ }
        }
        async function abrirPainel() {
            $lista.innerHTML = '<div class="sino-vazio">Carregando...</div>';
            $painel.style.display = 'block';
            try {
                const ns = await API.notificacoes();
                if (!ns.length) { $lista.innerHTML = '<div class="sino-vazio">Nenhuma notificação.</div>'; return; }
                $lista.innerHTML = ns.map(n => `
                    <div class="notif ${n.lida ? '' : 'nao-lida'}" data-id="${n.id}" data-ent="${n.entidade || ''}" data-eid="${n.entidade_id || ''}">
                        <div class="n-corpo">
                            <div class="n-tit">${esc(n.titulo)}</div>
                            ${n.corpo ? `<div class="n-txt">${esc(n.corpo)}</div>` : ''}
                            <div class="n-data">${formatarData(n.criado_em)}</div>
                        </div>
                        <button class="n-apagar" data-id="${n.id}" title="Apagar">×</button>
                    </div>`).join('');
                $lista.querySelectorAll('.notif').forEach(el => {
                    el.addEventListener('click', async (ev) => {
                        if (ev.target.classList.contains('n-apagar')) return;
                        try { await API.notifLida(+el.dataset.id); } catch (e) {}
                        el.classList.remove('nao-lida'); atualizarBadge();
                        // Navega ao chamado relacionado, se aplicável.
                        if (el.dataset.ent === 'chamado' && el.dataset.eid) {
                            $painel.style.display = 'none';
                            if (ehAdmin) { navegar('gestao'); abrirModalAdmin(+el.dataset.eid); }
                            else { navegar('meus'); abrirModalUsuario(+el.dataset.eid); }
                        }
                    });
                });
                $lista.querySelectorAll('.n-apagar').forEach(b =>
                    b.addEventListener('click', async (ev) => {
                        ev.stopPropagation();
                        try { await API.notifApagar(+b.dataset.id); } catch (e) {}
                        b.closest('.notif').remove(); atualizarBadge();
                    }));
            } catch (e) { $lista.innerHTML = `<div class="sino-vazio">${esc(e.message)}</div>`; }
        }
        $sino.addEventListener('click', (e) => {
            e.stopPropagation();
            if ($painel.style.display === 'block') { $painel.style.display = 'none'; }
            else abrirPainel();
        });
        document.addEventListener('click', e => {
            if (!e.target.closest('.sino-wrap')) $painel.style.display = 'none';
        });
        document.getElementById('sino-lidas').addEventListener('click', async () => {
            try { await API.notifTodasLidas(); abrirPainel(); atualizarBadge(); } catch (e) {}
        });
        document.getElementById('sino-limpar').addEventListener('click', async () => {
            try { await API.notifApagarTodas(); abrirPainel(); atualizarBadge(); } catch (e) {}
        });
        atualizarBadge();
        setInterval(atualizarBadge, 30000);  // poll a cada 30s
    }

    // ================================================================== //
    // MEU PERFIL
    // ================================================================== //
    function abrirPerfil() {
        document.getElementById('modal-titulo').textContent = 'Meu perfil';
        document.getElementById('modal-corpo').innerHTML = `
            <div class="detalhe-linha detalhe-grade">
                <div><div class="rot">Nome</div><div class="val">${esc(usuario.nome)}</div></div>
                <div><div class="rot">Papel</div><div class="val">${esc(ROTULO_PAPEL[papel] || '—')}</div></div>
            </div>
            <div class="linha-campos">
                <div class="campo"><label>E-mail</label><input id="perf-email" placeholder="voce@empresa.com"></div>
                <div class="campo"><label>Ramal</label><input id="perf-ramal"></div>
            </div>
            <button class="btn btn-secundario btn-mini" id="perf-salvar">Salvar contato</button>
            <div class="detalhe-linha" style="margin-top:18px;border-top:1px solid var(--cor-borda);padding-top:14px;">
                <button class="btn btn-fantasma btn-mini" id="perf-senha">Trocar minha senha</button>
            </div>
            <div id="modal-alerta" class="alerta"></div>`;
        document.getElementById('modal-rodape').innerHTML = `<button class="btn btn-secundario" id="perf-fechar">Fechar</button>`;
        document.getElementById('perf-fechar').addEventListener('click', fecharModal);
        // Preenche e-mail/ramal atuais.
        API.me().then(u => {
            document.getElementById('perf-email').value = u.email || '';
            document.getElementById('perf-ramal').value = u.ramal || '';
        }).catch(() => {});
        document.getElementById('perf-salvar').addEventListener('click', async () => {
            try {
                await API.atualizarPerfil({
                    email: document.getElementById('perf-email').value.trim(),
                    ramal: document.getElementById('perf-ramal').value.trim(),
                });
                alertaModal('Contato atualizado.'); document.getElementById('modal-alerta').className = 'alerta sucesso visivel';
            } catch (e) { alertaModal(e.message); }
        });
        document.getElementById('perf-senha').addEventListener('click', () => abrirTrocaSenha(false));
        mostrarModal();
    }

    // ================================================================== //
    // MODELOS DE CHAMADO (admin)
    // ================================================================== //
    async function carregarModelos() {
        const corpo = document.getElementById('corpo-modelos');
        corpo.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;">Carregando...</td></tr>`;
        try {
            const ms = await API.templatesAdmin();
            const cats = await garantirCategorias();
            const mapaCat = {}; cats.forEach(c => mapaCat[c.id] = c.nome);
            corpo.innerHTML = '';
            ms.forEach(m => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${esc(m.nome)}</strong></td>
                    <td>${esc(mapaCat[m.categoria_id] || '—')}</td>
                    <td>${esc(ROTULO_IMPACTO[m.impacto_negocio] || '—')}</td>
                    <td>${m.ativo ? '<span class="sla-chip sla-ok">Ativo</span>' : '<span class="sla-chip sla-vencido">Inativo</span>'}</td>
                    <td style="display:flex;gap:6px;">
                        <button class="btn-mini b-ed">Editar</button>
                        <button class="btn-mini b-ex" style="background:var(--grav-critica-bg);color:var(--grav-critica);">Excluir</button>
                    </td>`;
                tr.querySelector('.b-ed').addEventListener('click', () => abrirEditorModelo(m));
                tr.querySelector('.b-ex').addEventListener('click', async () => {
                    if (!confirm(`Excluir o modelo "${m.nome}"?`)) return;
                    try { await API.templateExcluir(m.id); carregarModelos(); } catch (e) { alert(e.message); }
                });
                corpo.appendChild(tr);
            });
        } catch (e) {
            corpo.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:30px;color:#b3261e;">${esc(e.message)}</td></tr>`;
        }
    }

    // ================================================================== //
    // CATEGORIAS / SUBCATEGORIAS (admin) — gestão da taxonomia
    // ================================================================== //
    async function carregarCategoriasAdmin() {
        const wrap = document.getElementById('lista-categorias');
        if (!wrap) return;
        wrap.innerHTML = '<p style="padding:20px;color:var(--cor-texto-suave);">Carregando...</p>';
        try {
            const cats = await API.categorias();
            wrap.innerHTML = '';
            if (!cats.length) {
                wrap.innerHTML = '<div class="vazio"><div class="ico-grande">🗂️</div>Nenhuma categoria cadastrada.</div>';
                return;
            }
            cats.forEach(cat => {
                const card = document.createElement('div');
                card.className = 'painel cat-card';
                const subs = (cat.subcategorias || []);
                card.innerHTML = `
                    <div class="cat-cab">
                        <strong>${esc(cat.nome)}</strong>
                        ${cat.ativo ? '' : '<span class="sla-chip sla-vencido">inativa</span>'}
                        <span class="cat-conta">${subs.length} subcategoria(s)</span>
                    </div>
                    <div class="cat-subs">
                        ${subs.length ? subs.map(s => `<span class="tag-chip">${esc(s.nome)}</span>`).join('')
                            : '<span style="color:var(--cor-texto-suave);font-size:13px;">Sem subcategorias.</span>'}
                    </div>
                    <div class="cat-add">
                        <input type="text" class="cat-sub-nome" placeholder="Nova subcategoria..." maxlength="80">
                        <button class="btn btn-fantasma btn-mini cat-sub-add">+ Adicionar</button>
                    </div>`;
                card.querySelector('.cat-sub-add').addEventListener('click', async () => {
                    const inp = card.querySelector('.cat-sub-nome');
                    const nome = inp.value.trim();
                    if (nome.length < 2) { inp.focus(); return; }
                    try {
                        await API.criarSubcategoria(nome, cat.id);
                        categoriasCache = [];
                        carregarCategoriasAdmin();
                    } catch (e) { alert(e.message); }
                });
                wrap.appendChild(card);
            });
        } catch (e) {
            wrap.innerHTML = `<p style="padding:20px;color:#b3261e;">${esc(e.message)}</p>`;
        }
    }
    (() => {
        const b = document.getElementById('btn-nova-categoria');
        if (b) b.addEventListener('click', async () => {
            const nome = (prompt('Nome da nova categoria:') || '').trim();
            if (nome.length < 2) return;
            try {
                await API.criarCategoria(nome);
                categoriasCache = [];
                carregarCategoriasAdmin();
            } catch (e) { alert(e.message); }
        });
    })();

    // Campos PADRÃO da abertura que um modelo pode ligar/desligar (formulário montável).
    const CAMPOS_PADRAO = [
        ['categoria', 'Categoria'], ['subcategoria', 'Subcategoria'], ['sistema', 'Sistema afetado'],
        ['modulo', 'Módulo / tela'], ['impacto', 'Impacto'], ['urgencia', 'Urgência'],
        ['unidade', 'Unidade / setor'], ['contato', 'Contato'], ['anexos', 'Anexos'],
    ];
    // chave do campo padrão → id do controle na tela de abertura
    const MAPA_CAMPOS_PADRAO = {
        categoria: 'abrir-categoria', subcategoria: 'abrir-subcategoria', sistema: 'abrir-sistema',
        modulo: 'abrir-modulo', impacto: 'abrir-impacto', urgencia: 'abrir-urgencia',
        unidade: 'abrir-unidade', contato: 'abrir-contato', anexos: 'abrir-anexos',
    };

    async function abrirEditorModelo(m) {
        const ed = !!m;
        const cats = await garantirCategorias();
        document.getElementById('modal-titulo').textContent = ed ? 'Editar modelo' : 'Novo modelo';
        const optsCat = '<option value="">Sem categoria</option>' +
            cats.map(c => `<option value="${c.id}" ${ed && m.categoria_id == c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('');
        const optsImp = ['', 'baixo', 'medio', 'alto', 'critico']
            .map(i => `<option value="${i}" ${ed && (m.impacto_negocio || '') === i ? 'selected' : ''}>${i ? ROTULO_IMPACTO[i] : '—'}</option>`).join('');
        const marcado = k => (!ed || !m.campos_padrao || m.campos_padrao[k] !== false) ? 'checked' : '';
        const togglesPadrao = CAMPOS_PADRAO.map(([k, lab]) =>
            `<label class="cp-check"><input type="checkbox" id="md-pad-${k}" ${marcado(k)}> ${lab}</label>`).join('');

        document.getElementById('modal-corpo').innerHTML = `
            <div class="campo"><label>Nome do modelo</label><input id="md-nome" value="${ed ? esc(m.nome) : ''}"></div>
            <div class="campo"><label>Título sugerido</label><input id="md-titulo" value="${ed ? esc(m.titulo || '') : ''}"></div>
            <div class="campo"><label>Descrição pré-preenchida</label><textarea id="md-desc" style="min-height:100px;">${ed ? esc(m.descricao || '') : ''}</textarea></div>
            <div class="linha-campos">
                <div class="campo"><label>Categoria</label><select id="md-cat">${optsCat}</select></div>
                <div class="campo"><label>Subcategoria</label><select id="md-sub"><option value="">Sem subcategoria</option></select></div>
            </div>
            <div class="linha-campos">
                <div class="campo"><label>Impacto</label><select id="md-imp">${optsImp}</select></div>
                <div class="campo"><label>Sistema afetado</label><input id="md-sis" value="${ed ? esc(m.sistema_afetado || '') : ''}"></div>
            </div>
            <div class="campo">
                <label>Campos padrão exibidos na abertura</label>
                <div class="ajuda" style="margin-bottom:8px;">Desmarque os que este modelo NÃO deve mostrar. (Título e descrição são sempre exigidos.)</div>
                <div class="md-padrao-grid">${togglesPadrao}</div>
            </div>
            <div class="campo">
                <label>Campos personalizados (chamado modular)</label>
                <div class="ajuda" style="margin-bottom:8px;">Aparecem na abertura quando este modelo é escolhido. Use ↑↓ para ordenar; em <strong>Seleção</strong>/<strong>Múltipla</strong>, informe as opções separadas por vírgula.</div>
                <div id="md-campos-lista"></div>
                <button type="button" id="md-add-campo" class="btn btn-fantasma btn-mini">+ Adicionar campo</button>
            </div>
            ${ed ? `<div class="campo"><label>Situação</label><select id="md-ativo"><option value="1" ${m.ativo ? 'selected' : ''}>Ativo</option><option value="0" ${!m.ativo ? 'selected' : ''}>Inativo</option></select></div>` : ''}
            <div id="modal-alerta" class="alerta"></div>`;

        // Subcategoria depende da categoria escolhida.
        function preencherMdSub(catId, selId) {
            const sel = document.getElementById('md-sub');
            const cat = cats.find(c => String(c.id) === String(catId));
            const subs = cat ? (cat.subcategorias || []) : [];
            sel.innerHTML = '<option value="">Sem subcategoria</option>' +
                subs.map(s => `<option value="${s.id}" ${String(selId) === String(s.id) ? 'selected' : ''}>${esc(s.nome)}</option>`).join('');
        }
        preencherMdSub(ed ? m.categoria_id : '', ed ? m.subcategoria_id : '');
        document.getElementById('md-cat').addEventListener('change', e => preencherMdSub(e.target.value, ''));

        // --- Construtor de campos personalizados ---
        const TIPOS_CAMPO = [
            ['texto', 'Texto'], ['texto_longo', 'Texto longo'], ['numero', 'Número'],
            ['data', 'Data'], ['selecao', 'Seleção'], ['multipla', 'Múltipla escolha'],
            ['booleano', 'Sim/Não'],
        ];
        let mdCampos = ed && Array.isArray(m.campos_personalizados)
            ? m.campos_personalizados.map(c => ({ ...c })) : [];

        function linhaCampo(c) {
            const comOpcoes = c.tipo === 'selecao' || c.tipo === 'multipla';
            const opts = TIPOS_CAMPO.map(([val, lab]) =>
                `<option value="${val}" ${c.tipo === val ? 'selected' : ''}>${lab}</option>`).join('');
            return `<div class="md-campo-row" data-chave="${esc(c.chave || '')}">
                <div class="mc-linha1">
                    <input class="mc-rotulo" placeholder="Rótulo do campo" value="${esc(c.rotulo || '')}">
                    <select class="mc-tipo">${opts}</select>
                    <label class="cp-check"><input type="checkbox" class="mc-obrig" ${c.obrigatorio ? 'checked' : ''}> obrig.</label>
                    <button type="button" class="mc-subir btn btn-fantasma btn-mini" title="Subir">↑</button>
                    <button type="button" class="mc-descer btn btn-fantasma btn-mini" title="Descer">↓</button>
                    <button type="button" class="mc-remover btn btn-fantasma btn-mini" title="Remover">✕</button>
                </div>
                <div class="mc-linha2">
                    <input class="mc-opcoes" placeholder="Opções (separadas por vírgula)" value="${esc((c.opcoes || []).join(', '))}" style="${comOpcoes ? '' : 'display:none;'}">
                    <input class="mc-padrao" placeholder="Valor padrão (opcional)" value="${esc(c.padrao || '')}">
                </div>
            </div>`;
        }
        function lerMdCampos() {
            return Array.from(document.querySelectorAll('#md-campos-lista .md-campo-row')).map(r => ({
                chave: r.dataset.chave || null,   // preserva a chave original
                rotulo: r.querySelector('.mc-rotulo').value.trim(),
                tipo: r.querySelector('.mc-tipo').value,
                obrigatorio: r.querySelector('.mc-obrig').checked,
                opcoes: r.querySelector('.mc-opcoes').value.split(',').map(s => s.trim()).filter(Boolean),
                padrao: r.querySelector('.mc-padrao').value.trim() || null,
            }));
        }
        function renderMdCampos() {
            const lista = document.getElementById('md-campos-lista');
            lista.innerHTML = mdCampos.map(linhaCampo).join('');
            lista.querySelectorAll('.md-campo-row').forEach((r, i) => {
                r.querySelector('.mc-tipo').addEventListener('change', e => {
                    const com = e.target.value === 'selecao' || e.target.value === 'multipla';
                    r.querySelector('.mc-opcoes').style.display = com ? '' : 'none';
                });
                r.querySelector('.mc-remover').addEventListener('click', () => {
                    mdCampos = lerMdCampos(); mdCampos.splice(i, 1); renderMdCampos();
                });
                r.querySelector('.mc-subir').addEventListener('click', () => {
                    mdCampos = lerMdCampos();
                    if (i > 0) { [mdCampos[i - 1], mdCampos[i]] = [mdCampos[i], mdCampos[i - 1]]; renderMdCampos(); }
                });
                r.querySelector('.mc-descer').addEventListener('click', () => {
                    mdCampos = lerMdCampos();
                    if (i < mdCampos.length - 1) { [mdCampos[i + 1], mdCampos[i]] = [mdCampos[i], mdCampos[i + 1]]; renderMdCampos(); }
                });
            });
        }
        renderMdCampos();
        document.getElementById('md-add-campo').addEventListener('click', () => {
            mdCampos = lerMdCampos();
            mdCampos.push({ rotulo: '', tipo: 'texto', obrigatorio: false, opcoes: [], padrao: null });
            renderMdCampos();
        });

        document.getElementById('modal-rodape').innerHTML = `
            <button class="btn btn-fantasma" id="md-cancelar">Cancelar</button>
            <button class="btn btn-primario" id="md-salvar">Salvar</button>`;
        document.getElementById('md-cancelar').addEventListener('click', fecharModal);
        document.getElementById('md-salvar').addEventListener('click', async () => {
            const v = id => document.getElementById(id) ? document.getElementById(id).value.trim() : '';
            const campos = lerMdCampos().filter(c => c.rotulo);
            const semOpcoes = campos.find(c => (c.tipo === 'selecao' || c.tipo === 'multipla') && !c.opcoes.length);
            if (semOpcoes) return alertaModal(`O campo "${semOpcoes.rotulo}" é de seleção e precisa de opções.`);
            const campos_padrao = {};
            CAMPOS_PADRAO.forEach(([k]) => { campos_padrao[k] = document.getElementById('md-pad-' + k).checked; });
            const dados = {
                nome: v('md-nome'), titulo: v('md-titulo') || null, descricao: v('md-desc') || null,
                categoria_id: v('md-cat') ? +v('md-cat') : null,
                subcategoria_id: v('md-sub') ? +v('md-sub') : null,
                impacto_negocio: v('md-imp') || null,
                sistema_afetado: v('md-sis') || null,
                ativo: ed ? v('md-ativo') === '1' : true,
                campos_personalizados: campos,
                campos_padrao,
            };
            if (dados.nome.length < 3) return alertaModal('Nome do modelo muito curto.');
            try {
                if (ed) await API.templateAtualizar(m.id, dados); else await API.templateCriar(dados);
                fecharModal(); carregarModelos();
            } catch (e) { alertaModal(e.message); }
        });
        mostrarModal();
    }

    // ================================================================== //
    // CONFIGURAÇÕES DE SLA (admin) — feriados em calendário
    // ================================================================== //
    let feriadosMap = {};
    let calMes = new Date();  // primeiro dia do mês exibido
    const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const DOW = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    async function carregarConfig() {
        const form = document.getElementById('config-sla-form');
        form.innerHTML = 'Carregando...';
        try {
            const cfg = await API.configSla();
            form.innerHTML = [1, 2, 3, 4, 5].map(p => `
                <div class="campo linha-campos" style="grid-template-columns:auto 120px;align-items:center;">
                    <label style="margin:0;">Prioridade ${p}</label>
                    <input type="number" min="1" class="cfg-h" data-p="${p}" value="${cfg.horas_por_prioridade[p] ?? ''}">
                </div>`).join('');
            feriadosMap = {};
            (cfg.feriados || []).forEach(f => { feriadosMap[f.data] = f.descricao || ''; });
            // Posiciona o calendário no mês de hoje na primeira carga.
            calMes = new Date();
            renderCalendario();
        } catch (e) { form.innerHTML = `<span style="color:#b3261e;">${esc(e.message)}</span>`; }
    }

    function renderCalendario() {
        const cal = document.getElementById('calendario');
        if (!cal) return;
        const ano = calMes.getFullYear(), mes = calMes.getMonth();
        const hoje = iso(new Date());
        document.getElementById('cal-titulo').textContent = `${MESES[mes]} ${ano}`;
        document.getElementById('cal-add').style.display = 'none';

        let html = DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');
        const primeiroDow = new Date(ano, mes, 1).getDay();
        const diasNoMes = new Date(ano, mes + 1, 0).getDate();
        for (let i = 0; i < primeiroDow; i++) html += '<div class="cal-dia vazio"></div>';
        for (let dia = 1; dia <= diasNoMes; dia++) {
            const d = new Date(ano, mes, dia);
            const data = iso(d);
            const ehFds = d.getDay() === 0 || d.getDay() === 6;
            const ehFer = data in feriadosMap;
            const cls = ['cal-dia', ehFds ? 'fds' : '', ehFer ? 'feriado' : '', data === hoje ? 'hoje' : ''].filter(Boolean).join(' ');
            const titulo = ehFer ? esc(feriadosMap[data] || 'Feriado') : '';
            html += `<div class="${cls}" data-data="${data}" title="${titulo}">${dia}</div>`;
        }
        // Completa sempre 6 semanas (42 células) para a altura ficar FIXA entre os meses.
        for (let i = primeiroDow + diasNoMes; i < 42; i++) html += '<div class="cal-dia vazio"></div>';
        cal.innerHTML = html;
        cal.querySelectorAll('.cal-dia[data-data]').forEach(el =>
            el.addEventListener('click', () => cliqueDia(el.dataset.data, el)));
    }

    async function cliqueDia(data, el) {
        if (data in feriadosMap) {
            if (!confirm(`Remover o feriado "${feriadosMap[data] || ''}" (${data})?`)) return;
            try { await API.removerFeriado(data); delete feriadosMap[data]; renderCalendario(); }
            catch (e) { alert(e.message); }
            return;
        }
        // Dia livre: abre o mini-formulário para marcar.
        document.querySelectorAll('.cal-dia.sel').forEach(s => s.classList.remove('sel'));
        el.classList.add('sel');
        const box = document.getElementById('cal-add');
        box.style.display = 'flex';
        box.innerHTML = `
            <span>Marcar <strong>${data}</strong>:</span>
            <input type="text" id="cal-desc" placeholder="Descrição (opcional)" style="flex:1;min-width:160px;">
            <button class="btn btn-primario btn-mini" id="cal-confirma">Adicionar feriado</button>
            <button class="btn btn-fantasma btn-mini" id="cal-cancela">Cancelar</button>`;
        const desc = document.getElementById('cal-desc');
        desc.focus();
        const confirmar = async () => {
            try {
                await API.adicionarFeriado(data, desc.value.trim());
                feriadosMap[data] = desc.value.trim();
                renderCalendario();
            } catch (e) { alert(e.message); }
        };
        document.getElementById('cal-confirma').addEventListener('click', confirmar);
        desc.addEventListener('keydown', e => { if (e.key === 'Enter') confirmar(); });
        document.getElementById('cal-cancela').addEventListener('click', () => {
            box.style.display = 'none'; el.classList.remove('sel');
        });
    }

    if (ehAdmin) {
        const bnm = document.getElementById('btn-novo-modelo');
        if (bnm) bnm.addEventListener('click', () => abrirEditorModelo(null));
        const bss = document.getElementById('btn-salvar-sla');
        if (bss) bss.addEventListener('click', async () => {
            const itens = [...document.querySelectorAll('.cfg-h')].map(i => ({ prioridade: +i.dataset.p, horas: +i.value }));
            try { await API.salvarConfigSla(itens); alert('Horas de SLA salvas.'); } catch (e) { alert(e.message); }
        });
        const cp = document.getElementById('cal-prev');
        if (cp) cp.addEventListener('click', () => { calMes.setMonth(calMes.getMonth() - 1); renderCalendario(); });
        const cn = document.getElementById('cal-prox');
        if (cn) cn.addEventListener('click', () => { calMes.setMonth(calMes.getMonth() + 1); renderCalendario(); });
        const bsf = document.getElementById('btn-sinc-feriados');
        if (bsf) bsf.addEventListener('click', async () => {
            bsf.disabled = true; const txt = bsf.textContent; bsf.innerHTML = '<span class="spinner"></span> Sincronizando...';
            try {
                const r = await API.sincronizarFeriados();
                await carregarConfig();
                alert(r.detail || 'Feriados sincronizados.');
            } catch (e) { alert(e.message); }
            finally { bsf.disabled = false; bsf.textContent = txt; }
        });
    }

    // ================================================================== //
    // CALENDÁRIO (todos) — prazos de SLA dos chamados visíveis + feriados
    // ================================================================== //
    let calGeralMes = new Date();
    async function carregarCalendarioGeral() {
        const ano = calGeralMes.getFullYear(), mes = calGeralMes.getMonth() + 1;
        const tit = document.getElementById('calg-titulo');
        if (tit) tit.textContent = `${MESES[mes - 1]} ${ano}`;
        const grade = document.getElementById('calg-grade');
        if (!grade) return;
        grade.innerHTML = '<div style="padding:24px;color:var(--cor-texto-suave);">Carregando...</div>';
        let ev;
        try { ev = await API.calendarioEventos(ano, mes); }
        catch (e) { grade.innerHTML = `<div style="padding:24px;color:#b3261e;">${esc(e.message)}</div>`; return; }

        const feriasDia = {}; ev.feriados.forEach(f => feriasDia[f.data] = f.descricao);
        const chDia = {}; ev.chamados.forEach(c => { (chDia[c.data] = chDia[c.data] || []).push(c); });

        const primeiro = new Date(ano, mes - 1, 1);
        const offset = primeiro.getDay();
        const diasNoMes = new Date(ano, mes, 0).getDate();
        let html = DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');
        for (let i = 0; i < offset; i++) html += '<div class="cal-cel vazia"></div>';
        for (let dia = 1; dia <= diasNoMes; dia++) {
            const k = iso(new Date(ano, mes - 1, dia));
            const fer = feriasDia[k];
            const evs = (chDia[k] || []).map(c => {
                const cls = c.encerrado ? 'ev-fim' : c.vencido ? 'ev-venc' : 'ev-ok';
                return `<button class="cal-ev ${cls}" data-id="${c.id}" title="${esc(c.titulo)} — ${esc(ROTULO_STATUS[c.status] || c.status)}">${esc(c.numero_protocolo || '#' + c.id)}</button>`;
            }).join('');
            html += `<div class="cal-cel ${fer ? 'cal-feriado' : ''}">
                <div class="cal-cel-num">${dia}</div>
                ${fer ? `<div class="cal-feriado-chip" title="${esc(fer)}">${esc(fer)}</div>` : ''}
                <div class="cal-evs">${evs}</div>
            </div>`;
        }
        grade.innerHTML = html;
        grade.querySelectorAll('.cal-ev').forEach(b => b.addEventListener('click', () => {
            const id = +b.dataset.id;
            if (ehAdmin) { navegar('gestao'); abrirModalAdmin(id); }
            else { navegar('meus'); abrirModalUsuario(id); }
        }));
    }
    (() => {
        const p = document.getElementById('calg-prev');
        const n = document.getElementById('calg-prox');
        if (p) p.addEventListener('click', () => { calGeralMes.setMonth(calGeralMes.getMonth() - 1); carregarCalendarioGeral(); });
        if (n) n.addEventListener('click', () => { calGeralMes.setMonth(calGeralMes.getMonth() + 1); carregarCalendarioGeral(); });
    })();

    // --- Busca global (topo) ---
    // Admin: abre a Gestão já filtrada. Demais: filtra "Meus chamados".
    const formBusca = document.getElementById('form-busca-global');
    if (formBusca) formBusca.addEventListener('submit', e => {
        e.preventDefault();
        const termo = document.getElementById('busca-global').value.trim();
        if (ehAdmin) {
            const fb = document.getElementById('filtro-busca');
            if (fb) fb.value = termo;
            paginaGestao = 0;
            navegar('gestao');
        } else {
            buscaMeusTexto = termo;
            navegar('meus');
        }
    });

    // --- Inicialização ---
    initSino();
    document.getElementById('btn-perfil').addEventListener('click', abrirPerfil);
    navegar(ehAdmin ? 'dashboard' : 'abrir');
    // Primeiro acesso com senha provisória: força a troca antes de usar o sistema.
    if (usuario.senhaProvisoria) abrirTrocaSenha(true);
})();
