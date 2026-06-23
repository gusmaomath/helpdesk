/* login.js — Lógica da tela de autenticação. */

(function () {
    // Se já está logado, vai direto para o app.
    if (API.obterToken()) {
        window.location.href = '/app';
        return;
    }

    // Toggle de tema também na tela de login.
    if (window.Tema) window.Tema.conectarBotao(document.getElementById('btn-tema'));

    const $matricula = document.getElementById('matricula');
    const $senha = document.getElementById('senha');
    const $btn = document.getElementById('btn-entrar');
    const $alerta = document.getElementById('alerta');

    function mostrarErro(msg) {
        $alerta.textContent = msg;
        $alerta.classList.add('visivel');
    }
    function limparErro() {
        $alerta.classList.remove('visivel');
    }

    async function entrar() {
        limparErro();
        const matricula = $matricula.value.trim();
        const senha = $senha.value;

        if (!matricula || !senha) {
            mostrarErro('Informe matrícula e senha.');
            return;
        }

        $btn.disabled = true;
        $btn.innerHTML = '<span class="spinner"></span> Entrando...';

        try {
            const r = await API.login(matricula, senha);
            API.salvarSessao(r.access_token, r.id, r.nome, r.nivel_acesso, r.papel,
                             r.senha_provisoria, r.organizacao);
            window.location.href = '/app';
        } catch (e) {
            mostrarErro(e.message);
            $btn.disabled = false;
            $btn.textContent = 'Entrar';
        }
    }

    $btn.addEventListener('click', entrar);
    // Enter no formulário envia.
    [$matricula, $senha].forEach(el =>
        el.addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); })
    );

    // ----------------------------- Cadastro ----------------------------- //
    const $cardLogin = document.getElementById('card-login');
    const $cardCad = document.getElementById('card-cadastro');
    const $alertaCad = document.getElementById('alerta-cad');
    const $btnCad = document.getElementById('btn-cadastrar');

    // Seletor de organização (marca) no cadastro — previa a cor ao vivo.
    function orgSelecionada() {
        const sel = document.querySelector('input[name="cad-org"]:checked');
        return sel ? sel.value : 'bradesco_bbi';
    }
    function previewMarca() {
        if (window.Tema) window.Tema.aplicarMarca(orgSelecionada() === 'agora' ? 'agora' : 'bradesco');
    }
    document.querySelectorAll('input[name="cad-org"]').forEach(r =>
        r.addEventListener('change', previewMarca));

    function alternar(paraCadastro) {
        $cardLogin.style.display = paraCadastro ? 'none' : 'block';
        $cardCad.style.display = paraCadastro ? 'block' : 'none';
        limparErro();
        $alertaCad.className = 'alerta';
        // No cadastro, a cor segue a organização escolhida; no login, padrão.
        if (window.Tema) window.Tema.aplicarMarca(paraCadastro && orgSelecionada() === 'agora' ? 'agora' : 'bradesco');
    }
    document.getElementById('link-cadastro').addEventListener('click', e => { e.preventDefault(); alternar(true); });
    document.getElementById('link-voltar-login').addEventListener('click', e => { e.preventDefault(); alternar(false); });

    function msgCad(texto, tipo) {
        $alertaCad.textContent = texto;
        $alertaCad.className = `alerta ${tipo} visivel`;
    }

    async function cadastrar() {
        const v = id => document.getElementById(id).value.trim();
        const nome = v('cad-nome'), matricula = v('cad-matricula'), senha = document.getElementById('cad-senha').value;
        if (nome.length < 2) return msgCad('Informe seu nome completo.', 'erro');
        if (!matricula) return msgCad('Informe sua matrícula.', 'erro');
        if (senha.length < 8) return msgCad('A senha deve ter ao menos 8 caracteres.', 'erro');

        $btnCad.disabled = true;
        $btnCad.innerHTML = '<span class="spinner"></span> Enviando...';
        try {
            const dados = { nome, matricula, senha, organizacao: orgSelecionada() };
            const setor = v('cad-setor'); if (setor) dados.unidade_setor = setor;
            const email = v('cad-email'); if (email) dados.email = email;
            const r = await API.registrar(dados);
            msgCad(r.detail || 'Solicitação enviada! Aguarde aprovação.', 'sucesso');
            ['cad-nome', 'cad-matricula', 'cad-setor', 'cad-email', 'cad-senha'].forEach(id => document.getElementById(id).value = '');
        } catch (e) {
            msgCad(e.message, 'erro');
        } finally {
            $btnCad.disabled = false;
            $btnCad.textContent = 'Enviar solicitação';
        }
    }
    $btnCad.addEventListener('click', cadastrar);
})();
