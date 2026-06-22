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

    // Aplica imediatamente (script roda no <head>).
    aplicar(temaSalvo());

    // API pública para o botão de toggle.
    window.Tema = {
        atual: temaSalvo,
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
