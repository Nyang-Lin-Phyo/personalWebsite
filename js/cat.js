/* cat.js — floating cat, cat jail, meow sounds (index page only) */

(function () {
    'use strict';

    /* ── Meow sounds (shared by footer button + jail) ── */
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

    /* ── Cat + jail shared state ── */
    const cat = document.getElementById('floatingCat');
    const jail = document.getElementById('catJail');
    const jailLabel = document.getElementById('jailLabel');

    if (!cat || !jail) return;

    /* The animated cat and jail are motion extras —
       hide them entirely for reduced-motion users. */
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        cat.style.display = 'none';
        jail.style.display = 'none';
        return;
    }

    const CAT_IMG_FREE = 'assets/floatingCat.png';
    const CAT_IMG_HELD = 'assets/floatingCatHeld.png';
    const CAT_IMG_BLINK = 'assets/floatingCatBlinking.png';
    const catImg = cat.querySelector('img');

    /* ── Cat jail ──
       One label above the cage whose text depends on the state:
         hovering, cat free        → "cat jail"
         dragging cat over cage    → "Put in Jail?"
         jailed + hovering         → "drag me out~" */
    const LABEL_IDLE = 'cat jail';
    const LABEL_DROP = 'Put in Jail?';
    const LABEL_DRAG_OUT = 'drag me out~';

    let jailed = false;
    let jailMeowTimer = null;
    let mouseOverJail = false;
    let catDragging = false;    /* the cat is being dragged by the mouse */
    let catOverJail = false;    /* dragged cat overlaps the cage */

    function rectsOverlap(a, b) {
        return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    }

    /* The cage grows only while it is hovered — with the mouse alone
       or while holding the cat over it. Jailed stays small otherwise. */
    function refreshJail() {
        const big = mouseOverJail || catOverJail;
        jail.classList.toggle('jail-big', big);
        jail.classList.toggle('jail-small', !big);

        let text = null;
        if (catDragging) {
            /* once the held cat is over the cage (or the mouse is on it),
               it can be dropped inside */
            text = (catOverJail || mouseOverJail) ? LABEL_DROP : null;
        } else if (jailed) {
            text = mouseOverJail ? LABEL_DRAG_OUT : null;
        } else if (mouseOverJail) {
            text = LABEL_IDLE;
        }
        if (text) {
            jailLabel.textContent = text;
            jailLabel.style.opacity = '1';
        } else {
            jailLabel.style.opacity = '0';
        }
    }

    function scheduleNextMeow() {
        const delay = 10000 + Math.random() * 20000; /* 10–20 s */
        jailMeowTimer = setTimeout(() => {
            if (!jailed) return;
            playRandomMeow();
            spawnMeowFrom(jail);
            scheduleNextMeow();
        }, delay);
    }

    function jailCat() {
        jailed = true;
        jail.classList.add('jailed');
        jail.style.cursor = 'grab';
        cat.style.display = 'none';
        refreshJail();
        scheduleNextMeow();
    }

    function unjailCat() {
        jailed = false;
        clearTimeout(jailMeowTimer);
        jailMeowTimer = null;
        jail.classList.remove('jailed');
        jail.style.cursor = 'default';
        cat.style.display = '';
        refreshJail();
    }

    /* ── Hover on the cage ── */
    jail.addEventListener('mouseenter', () => {
        mouseOverJail = true;
        refreshJail();
    });

    jail.addEventListener('mouseleave', () => {
        mouseOverJail = false;
        refreshJail();
    });

    /* Drag-out: mousedown on the jailed cat starts the release drag */
    jail.addEventListener('mousedown', e => {
        if (!jailed) return;
        e.preventDefault();
        unjailCat();
        handCatToMouse(e.clientX, e.clientY);
    });

    /* ── Hooks the floating cat calls while being dragged ── */
    function onCatDragStart() {
        catDragging = true;
        catOverJail = false;
        refreshJail();
    }

    function onCatDragMove(over) {
        if (!catDragging || over === catOverJail) return;
        catOverJail = over;
        refreshJail();
    }

    function onCatDrop(over) {
        catDragging = false;
        catOverJail = false;
        if (!jailed && over) jailCat();
        else refreshJail();
    }


    /* ── Floating cat ──
       handCatToMouse is used by the jail to hand the cat back mid-drag. */
    let handCatToMouse = null;

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

        handCatToMouse = function (mouseX, mouseY) {
            x = mouseX - CAT_W / 2;
            y = mouseY - CAT_H / 2;
            cat.style.transform = `translate(${x}px, ${y}px)`;
            dragging = true;
            dragOffX = CAT_W / 2;
            dragOffY = CAT_H / 2;
            lastMouseX = mouseX;
            lastMouseY = mouseY;
            throwVX = 0;
            throwVY = 0;
            vx = 0;
            vy = 0;
            cat.style.cursor = 'grabbing';
            catImg.src = CAT_IMG_HELD;
            startShake();
            onCatDragStart();
        };

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
            onCatDragStart();
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
                    if (!jailed) catImg.src = CAT_IMG_FREE;
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
            if (!jailed) {
                const catRect = { left: x, top: y, right: x + CAT_W, bottom: y + CAT_H };
                onCatDragMove(rectsOverlap(catRect, jail.getBoundingClientRect()));
            }
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            stopShake();
            cat.style.cursor = 'grab';
            catImg.src = CAT_IMG_FREE;
            vx = throwVX;
            vy = throwVY;
            if (!jailed) {
                const catRect = { left: x, top: y, right: x + CAT_W, bottom: y + CAT_H };
                onCatDrop(rectsOverlap(catRect, jail.getBoundingClientRect()));
            }
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

                cat.style.transform = `translate(${x}px, ${y}px)`;
            } else {
                cat.style.transform = `translate(${x + shakeX}px, ${y + shakeY}px)`;
            }

            requestAnimationFrame(tick);
        }

        tick();
    }

    if (catImg.complete) initCat();
    else catImg.addEventListener('load', initCat);
})();
