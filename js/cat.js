/* cat.js — floating cat & meow sounds (index page only) */

(function () {
    'use strict';

    /* ── Meow sounds ── */
    const CAT_SOUNDS = [
        'assets/catSounds/mixkit-angry-cartoon-kitty-meow-94.wav',
        'assets/catSounds/mixkit-cartoon-kitty-begging-meow-92.wav',
        'assets/catSounds/mixkit-cartoon-little-cat-meow-91.wav',
        'assets/catSounds/mixkit-domestic-cat-hungry-meow-45.wav',
        'assets/catSounds/mixkit-little-cat-attention-meow-86.wav',
        'assets/catSounds/mixkit-little-cat-pain-meow-87.wav',
        'assets/catSounds/mixkit-sweet-kitty-meow-93.wav',
    ];

    const MEOW_VARIANTS = ['meow', 'mrrrow', 'meow!!', 'mew', 'MEOW', 'prrrmeow', 'meow~'];

    function playRandomMeow() {
        const sound = new Audio(CAT_SOUNDS[Math.floor(Math.random() * CAT_SOUNDS.length)]);
        sound.volume = 0.6;
        sound.play().catch(() => { });
    }

    function spawnMeowFrom(anchorEl) {
        const word = MEOW_VARIANTS[Math.floor(Math.random() * MEOW_VARIANTS.length)];
        const span = document.createElement('span');
        span.textContent = word;
        span.setAttribute('aria-hidden', 'true');
        Object.assign(span.style, {
            position: 'fixed',
            fontFamily: 'var(--serif)',
            fontSize: (1.1 + Math.random() * 0.7) + 'rem',
            color: 'var(--purple)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 9999,
            opacity: 1,
            transition: 'opacity 0.8s ease, transform 1.2s ease',
        });
        const rect = anchorEl.getBoundingClientRect();
        span.style.left = (rect.left + Math.random() * rect.width - 20) + 'px';
        span.style.top = (rect.top - 10) + 'px';
        document.body.appendChild(span);
        requestAnimationFrame(() => requestAnimationFrame(() => {
            span.style.transform = `translateY(-${40 + Math.random() * 30}px) rotate(${(Math.random() - 0.5) * 20}deg)`;
            span.style.opacity = '0';
        }));
        setTimeout(() => span.remove(), 1300);
    }

    /* Footer "Built with Cats" meow button */
    const footerMeow = document.getElementById('footerMeow');
    if (footerMeow) {
        footerMeow.addEventListener('click', () => {
            playRandomMeow();
            spawnMeowFrom(footerMeow);
        });
    }

    /* ── Floating cat ── */
    const cat = document.getElementById('floatingCat');
    if (!cat) return;

    /* The animated cat is a motion extra — hide it for reduced-motion users. */
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        cat.style.display = 'none';
        return;
    }

    const CAT_IMG_FREE = 'assets/floatingCat.png';
    const CAT_IMG_HELD = 'assets/floatingCatHeld.png';
    const CAT_IMG_BLINK = 'assets/floatingCatBlinking.png';
    const catImg = cat.querySelector('img');

    function initCat() {
        const PAD = 0;
        const nav = document.querySelector('nav');
        const TOP = nav ? nav.offsetHeight : 0;
        const MIN_SPEED = 0.07;
        const MAX_SPEED = 0.8;
        const CAT_W = cat.offsetWidth;
        const CAT_H = cat.offsetHeight;

        let x = window.innerWidth - CAT_W - 20;
        let y = TOP + (window.innerHeight - TOP) / 2 - CAT_H / 2;

        const angle = Math.random() * Math.PI * 2;
        const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
        let vx = Math.cos(angle) * speed;
        let vy = Math.sin(angle) * speed;

        let dragging = false;
        let dragOffX = 0;
        let dragOffY = 0;
        let lastMouseX = 0;
        let lastMouseY = 0;
        let throwVX = 0;
        let throwVY = 0;
        let shakeX = 0;
        let shakeY = 0;
        let shakeInterval = null;

        function startShake() {
            clearInterval(shakeInterval);
            shakeInterval = setInterval(() => {
                shakeX = (Math.random() - 0.5) * 4;
                shakeY = (Math.random() - 0.5) * 4;
            }, 40);
        }

        function stopShake() {
            clearInterval(shakeInterval);
            shakeInterval = null;
            shakeX = 0;
            shakeY = 0;
        }

        cat.addEventListener('mousedown', e => {
            dragging = true;
            dragOffX = e.clientX - x;
            dragOffY = e.clientY - y;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            throwVX = 0;
            throwVY = 0;
            cat.style.cursor = 'grabbing';
            catImg.src = CAT_IMG_HELD;
            startShake();
            e.preventDefault();
        });

        function scheduleBlink() {
            const delay = (3 + Math.random() * 5) * 1000;
            setTimeout(() => {
                if (dragging) {
                    scheduleBlink();
                    return;
                }
                catImg.src = CAT_IMG_BLINK;
                setTimeout(() => {
                    catImg.src = CAT_IMG_FREE;
                    scheduleBlink();
                }, 150);
            }, delay);
        }
        scheduleBlink();

        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            throwVX = e.clientX - lastMouseX;
            throwVY = e.clientY - lastMouseY;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            x = e.clientX - dragOffX;
            y = e.clientY - dragOffY;
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            stopShake();
            cat.style.cursor = 'grab';
            catImg.src = CAT_IMG_FREE;
            vx = throwVX;
            vy = throwVY;
        });

        function tick() {
            cat.style.visibility = 'visible';

            if (!dragging) {
                const spd = Math.sqrt(vx * vx + vy * vy);
                if (spd > MAX_SPEED) {
                    const factor = MAX_SPEED / spd;
                    vx += (vx * factor - vx) * 0.05;
                    vy += (vy * factor - vy) * 0.05;
                } else if (spd < MIN_SPEED && spd > 0.001) {
                    const factor = MIN_SPEED / spd;
                    vx += (vx * factor - vx) * 0.05;
                    vy += (vy * factor - vy) * 0.05;
                } else if (spd <= 0.001) {
                    const a = Math.random() * Math.PI * 2;
                    vx = Math.cos(a) * MIN_SPEED;
                    vy = Math.sin(a) * MIN_SPEED;
                }

                x += vx;
                y += vy;

                if (x <= PAD) { x = PAD; vx = Math.abs(vx); }
                if (x >= window.innerWidth - CAT_W - PAD) { x = window.innerWidth - CAT_W - PAD; vx = -Math.abs(vx); }
                if (y <= TOP) { y = TOP; vy = Math.abs(vy); }
                if (y >= window.innerHeight - CAT_H) { y = window.innerHeight - CAT_H; vy = -Math.abs(vy); }
            }

            cat.style.transform = `translate(${x + shakeX}px, ${y + shakeY}px)`;
            requestAnimationFrame(tick);
        }

        tick();
    }

    if (catImg.complete) initCat();
    else catImg.addEventListener('load', initCat);
})();
