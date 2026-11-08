/* main.js — shared across all pages: theme toggle + scroll-reveal */

(function () {
    'use strict';

    const root = document.documentElement;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ── Theme toggle ──────────────────────────────
       The initial theme is applied pre-paint by a tiny
       inline script in each page's <head> to avoid a
       flash of the wrong theme. This just wires the button. */
    const toggle = document.getElementById('themeToggle');

    function reflectTheme() {
        if (!toggle) return;
        const isLight = root.dataset.theme === 'light';
        toggle.setAttribute('aria-pressed', String(isLight));
        toggle.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
        toggle.setAttribute('title', isLight ? 'Switch to dark mode' : 'Switch to light mode');
    }

    if (toggle) {
        reflectTheme();
        toggle.addEventListener('click', () => {
            const next = root.dataset.theme === 'light' ? 'dark' : 'light';
            localStorage.setItem('theme', next);
            root.dataset.theme = next;
            reflectTheme();
        });
    }

    /* ── Scroll-reveal ─────────────────────────────
       Staggered inside full-height .layer sections,
       individually for loose .fade-up elements (projects page). */
    if (reducedMotion) {
        document.querySelectorAll('.fade-up').forEach(el => el.classList.add('visible'));
        return;
    }

    const reveal = (el, delay) => setTimeout(() => el.classList.add('visible'), delay);

    const layers = document.querySelectorAll('.layer');
    if (layers.length) {
        const layerObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                entry.target.querySelectorAll('.fade-up').forEach((el, i) => reveal(el, i * 90));
                layerObserver.unobserve(entry.target);
            });
        }, { threshold: 0.15 });
        layers.forEach(layer => layerObserver.observe(layer));
    }

    const looseFadeUps = [...document.querySelectorAll('.fade-up')].filter(el => !el.closest('.layer'));
    if (looseFadeUps.length) {
        const fadeObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                reveal(entry.target, 0);
                fadeObserver.unobserve(entry.target);
            });
        }, { threshold: 0.1 });
        looseFadeUps.forEach(el => fadeObserver.observe(el));
    }
})();
