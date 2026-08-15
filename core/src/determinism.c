/*
 * Host-entropy shims.
 *
 * snes9x's libretro layer contains this, in retro_load_game():
 *
 *     srand(time(NULL));
 *     for (lcv = 0; lcv < sizeof(Memory.RAM); lcv++)
 *         Memory.RAM[lcv] = rand() % 256;
 *
 * Two peers loading the same ROM one second apart therefore start with 128KB
 * of *different* work RAM, and any game that seeds its RNG from uninitialised
 * WRAM diverges on the first random event. psnes_core pins that option off,
 * but "the netplay is correct as long as nobody flips an option" is not a
 * guarantee worth having, so the entropy sources themselves are replaced.
 *
 * These are linked in via -Wl,--wrap so they intercept every call in the core,
 * including any we have not audited. rand() becomes a fixed-seed xorshift and
 * the clock becomes a constant, which makes "load a ROM" a pure function.
 */

#include <stdint.h>
#include <stddef.h>
#include <time.h>
#include <sys/time.h>

/*
 * The real headers, not hand-rolled declarations. time_t is 64-bit on wasm32
 * while long is 32-bit, so a shim declared as `long time(long *)` links
 * cleanly and then produces a module the wasm validator rejects: callers store
 * an i64 where the shim returned an i32.
 */

#define PN_DEFAULT_SEED 0x5EED1234u

static uint32_t pn_rng_state = PN_DEFAULT_SEED;

/* Fixed instant (2000-01-01T00:00:00Z) handed to anything asking for the time. */
#define PN_FIXED_EPOCH ((time_t)946684800)

int __wrap_rand(void)
{
    /* xorshift32: same sequence on every machine, unlike glibc/musl rand()
     * whose algorithms differ between libcs. */
    uint32_t x = pn_rng_state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    pn_rng_state = x;
    return (int)(x & 0x7FFFFFFF);
}

void __wrap_srand(unsigned int seed)
{
    /* Honour the seed so a caller that deliberately reseeds still gets a
     * reproducible stream, but never let seed 0 collapse the generator. */
    pn_rng_state = seed ? seed : PN_DEFAULT_SEED;
}

time_t __wrap_time(time_t *t)
{
    if (t)
        *t = PN_FIXED_EPOCH;
    return PN_FIXED_EPOCH;
}

clock_t __wrap_clock(void)
{
    return (clock_t)0;
}

int __wrap_gettimeofday(struct timeval *tv, void *tz)
{
    (void)tz;
    if (tv)
    {
        tv->tv_sec  = PN_FIXED_EPOCH;
        tv->tv_usec = 0;
    }
    return 0;
}

/* Reset hook so the test suite can prove a fresh instance replays the same
 * stream, and so pn_reset() can put entropy back where it started. */
void pn_reset_entropy(void)
{
    pn_rng_state = PN_DEFAULT_SEED;
}
