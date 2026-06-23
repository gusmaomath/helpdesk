/* =========================================================================
   tema.js — Gerencia o tema claro/escuro.
   Aplica o tema salvo o quanto antes (no <head>) para evitar "flash" de cor.
   Persiste a escolha em localStorage (sobrevive ao fechar o navegador).
   ========================================================================= */
(function () {
    'use strict';
    const CHAVE = 'helpdesk_tema';

    function temaSalvo() {
        const t = localStorage.getItem(CHAVE);
        if (t === 'dark' || t === 'light') return t;
        // Respeita a preferência do sistema na primeira visita.
        return window.matchMedia &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark' : 'light';
    }

    function aplicar(tema) {
        document.documentElement.setAttribute('data-theme', tema);
    }

    // --- Marca (esquema de cores: Bradesco BBI vinho / Ágora verde) ---
    // A marca vem do usuário logado (sessionStorage). 'agora' troca a paleta;
    // qualquer outro valor cai no padrão Bradesco BBI.
    function marcaDoUsuario() {
        try {
            const u = JSON.parse(sessionStorage.getItem('helpdesk_usuario') || 'null');
            return u && u.org === 'agora' ? 'agora' : 'bradesco';
        } catch (_) { return 'bradesco'; }
    }
    function aplicarMarca(marca) {
        document.documentElement.setAttribute(
            'data-marca', marca === 'agora' ? 'agora' : 'bradesco');
    }

    // Aplica imediatamente (script roda no <head>) — tema e marca, sem flash.
    aplicar(temaSalvo());
    aplicarMarca(marcaDoUsuario());

    // API pública para o botão de toggle.
    window.Tema = {
        atual: temaSalvo,
        /** Aplica uma marca (cor) — usado no preview do cadastro e ao logar. */
        aplicarMarca,
        marcaDoUsuario,
        alternar() {
            const novo = temaSalvo() === 'dark' ? 'light' : 'dark';
            localStorage.setItem(CHAVE, novo);
            aplicar(novo);
            return novo;
        },
        /** Liga um botão ao toggle e mantém seu rótulo atualizado. */
        conectarBotao(botao) {
            if (!botao) return;
            const render = () => {
                const escuro = temaSalvo() === 'dark';
                botao.innerHTML = escuro ? '☀️ Claro' : '🌙 Escuro';
                botao.setAttribute('aria-label',
                    escuro ? 'Mudar para tema claro' : 'Mudar para tema escuro');
            };
            render();
            botao.addEventListener('click', () => { this.alternar(); render(); });
        },
    };
})();
