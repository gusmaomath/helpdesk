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
    const itensMenu = ehAdmin
        ? [
            { id: 'dashboard', ico: '📊', rotulo: 'Painel' },
            { id: 'gestao', ico: '🗂️', rotulo: 'Chamados' },
            { id: 'kanban', ico: '🔲', rotulo: 'Kanban' },
            { id: 'kb', ico: '📚', rotulo: 'Conhecimento' },
            { id: 'usuarios', ico: '👥', rotulo: 'Usuários' },
            { id: 'auditoria', ico: '📜', rotulo: 'Auditoria' },
            { id: 'ajuda', ico: '❓', rotulo: 'Como usar' },
          ]
        : [
            { id: 'abrir', ico: '➕', rotulo: 'Abrir chamado' },
            { id: 'meus', ico: '📋', rotulo: 'Meus chamados' },
            { id: 'kb', ico: '📚', rotulo: 'Conhecimento' },
            { id: 'ajuda', ico: '❓', rotulo: 'Como usar' },
          ];
    itensMenu.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'item-menu';
        btn.dataset.pagina = item.id;
        btn.innerHTML = `<span class="ico">${item.ico}</span><span>${item.rotulo}</span>`;
        btn.addEventListener('click', () => navegar(item.id));
        menu.appendChild(btn);
    });

    function navegar(pagina) {
        document.querySelectorAll('.pagina').forEach(p => p.classList.remove('ativa'));
        document.querySelectorAll('.item-menu').forEach(b => b.classList.remove('ativo'));
        const sec = document.getElementById('pg-' + pagina);
        if (sec) sec.classList.add('ativa');
        const btn = document.querySelector(`.item-menu[data-pagina="${pagina}"]`);
        if (btn) btn.classList.add('ativo');

        if (pagina === 'meus') carregarMeusChamados();
        if (pagina === 'equipe') carregarEquipe();
        if (pagina === 'gestao') carregarGestao();
        if (pagina === 'kanban') carregarKanban();
        if (pagina === 'kb') carregarKb();
        if (pagina === 'dashboard') carregarDashboard();
        if (pagina === 'usuarios') carregarUsuarios();
        if (pagina === 'auditoria') carregarAuditoria();
        if (pagina === 'abrir') carregarCategoriasAbrir();
        if (pagina === 'ajuda') carregarAjuda();
    }

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
    async function carregarCategoriasAbrir() {
        if (ehAdmin) return;
        const cats = await garantirCategorias();
        const selCat = document.getElementById('abrir-categoria');
        const selSub = document.getElementById('abrir-subcategoria');
        if (!selCat) return;
        preencherSelectCategorias(selCat, cats);
        selCat.onchange = () => preencherSelectSubcategorias(selSub, cats, selCat.value);
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
        const lista = filtro
            ? meusChamadosCache.filter(c => c.autor && String(c.autor.id) === String(filtro))
            : meusChamadosCache;

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

    function renderAnexos(c) {
        if (!c.anexos || !c.anexos.length) return '';
        const itens = c.anexos.map(a => `
            <button type="button" class="anexo-item anexo-baixar"
                    data-cid="${c.id}" data-aid="${a.id}" data-nome="${esc(a.nome_original)}">
                <span>📎 ${esc(a.nome_original)}</span>
                <span style="color:var(--cor-primaria);font-weight:600;">baixar</span>
            </button>`).join('');
        return `<div class="detalhe-linha"><div class="rot">Anexos (${c.anexos.length})</div>${itens}</div>`;
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
        const btn = e.target.closest ? e.target.closest('.anexo-baixar') : null;
        if (btn) baixarAnexoArquivo(+btn.dataset.cid, +btn.dataset.aid, btn.dataset.nome);
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
            de: document.getElementById('filtro-de').value,
            ate: document.getElementById('filtro-ate').value,
            busca: document.getElementById('filtro-busca').value.trim(),
            limite: TAM_PAGINA,
            offset: paginaGestao * TAM_PAGINA,
        };
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
            </div>

            <!-- ABA: CONHECIMENTO (similares + KB + promover) -->
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
            ['filtro-status', 'filtro-gravidade', 'filtro-categoria', 'filtro-sla', 'filtro-de', 'filtro-ate']
                .forEach(id => document.getElementById(id).addEventListener('change', recarregar));
            document.getElementById('btn-limpar-filtros').addEventListener('click', () => {
                ['filtro-busca', 'filtro-status', 'filtro-gravidade', 'filtro-categoria', 'filtro-sla', 'filtro-de', 'filtro-ate']
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
                    </td>`;
                tr.querySelector('.btn-editar').addEventListener('click', () => abrirModalUsuarioAdmin(u));
                const ap = tr.querySelector('.btn-aprovar');
                if (ap) ap.addEventListener('click', async () => {
                    if (!confirm(`Aprovar o acesso de ${u.nome}?`)) return;
                    try { await API.atualizarUsuario(u.id, { ativo: true }); carregarUsuarios(); }
                    catch (e) { alert(e.message); }
                });
                corpo.appendChild(tr);
            });
        } catch (e) {
            corpo.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:#b3261e;">${esc(e.message)}</td></tr>`;
        }
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
            <div id="modal-alerta" class="alerta"></div>`;
        document.getElementById('modal-rodape').innerHTML = ehAdmin
            ? `<button class="btn btn-perigo btn-mini" id="art-excluir">Excluir</button>
               <span class="espaco-flex"></span>
               <button class="btn btn-fantasma" id="art-fechar">Fechar</button>
               <button class="btn btn-primario" id="art-editar">Editar</button>`
            : `<button class="btn btn-secundario" id="art-fechar">Fechar</button>`;
        document.getElementById('art-fechar').addEventListener('click', fecharModal);
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
                borderColor: t.primaria, backgroundColor: grad, borderWidth: 2.5,
                fill: true, tension: 0.4, pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: t.primaria }] },
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

    // --- Inicialização ---
    navegar(ehAdmin ? 'dashboard' : 'abrir');
    // Primeiro acesso com senha provisória: força a troca antes de usar o sistema.
    if (usuario.senhaProvisoria) abrirTrocaSenha(true);
})();
