/**
 * Golden Fries unlock animation.
 *
 * Plays when a logged-in player's balance increases during the session. The total
 * duration is CONSTANT regardless of how many fries were gained: the number counts
 * up over a fixed time, and a fixed number of fries particles rain across the whole
 * screen. So +5 and +500 take exactly the same time.
 */

/** Count-up + pill pulse duration. */
const FRIES_ANIM_MS = 2000;
/** Fixed particle count — keeps the animation length independent of the amount. */
const FRIES_PARTICLES = 18;
/** How long a single particle takes to drift across the screen (higher = slower). */
const PARTICLE_FALL_MS = 3400;
/** Max random start delay for a particle (kept inside the fixed window). */
const PARTICLE_MAX_DELAY_MS = 600;

function rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

/**
 * Animates the top-left fries balance from `from` to `to` and fires the celebration
 * effect. `onComplete` runs when the count-up finishes.
 */
export function playGoldenFriesUnlock(from: number, to: number, onComplete?: () => void) {
    countUp(from, to, onComplete);
    pulsePill();
    rainParticles();
}

function countUp(from: number, to: number, onComplete?: () => void) {
    const el = document.getElementById("golden-fries-amount");
    const start = performance.now();

    const frame = (now: number) => {
        const t = Math.min(1, (now - start) / FRIES_ANIM_MS);
        const eased = 1 - (1 - t) ** 3; // easeOutCubic
        if (el) el.textContent = String(Math.round(from + (to - from) * eased));

        if (t < 1) {
            requestAnimationFrame(frame);
        } else {
            if (el) el.textContent = String(to);
            onComplete?.();
        }
    };

    requestAnimationFrame(frame);
}

function pulsePill() {
    const pill = document.getElementById("golden-fries-balance");
    if (!pill) return;
    // Restart the animation cleanly if it's somehow still applied.
    pill.classList.remove("golden-fries-unlock");
    void pill.offsetWidth; // force reflow so re-adding restarts the keyframes
    pill.classList.add("golden-fries-unlock");
    setTimeout(() => pill.classList.remove("golden-fries-unlock"), FRIES_ANIM_MS);
}

function rainParticles() {
    const fx = document.createElement("div");
    fx.className = "golden-fries-fx";

    let maxEnd = 0;
    for (let i = 0; i < FRIES_PARTICLES; i++) {
        const p = document.createElement("div");
        p.className = "golden-fries-particle";

        const delay = rand(0, PARTICLE_MAX_DELAY_MS);
        const duration = PARTICLE_FALL_MS;
        maxEnd = Math.max(maxEnd, delay + duration);

        p.style.left = `${rand(0, 100)}vw`;
        p.style.setProperty("--drift", `${rand(-140, 140)}px`);
        p.style.setProperty("--rot", `${rand(-220, 220)}deg`);
        p.style.setProperty("--scale", `${rand(0.6, 1.15)}`);
        p.style.animationDuration = `${duration}ms`;
        p.style.animationDelay = `${delay}ms`;

        fx.appendChild(p);
    }

    document.body.appendChild(fx);
    // Remove after the last particle finishes (fixed total — count is constant).
    setTimeout(() => fx.remove(), maxEnd + 100);
}
