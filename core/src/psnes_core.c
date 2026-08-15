/*
 * psnes_core - a deliberately tiny, deterministic libretro frontend for snes9x.
 *
 * The app already drives snes9x through a full RetroArch build. That build owns
 * its own main loop, reads the browser gamepad API, and reads its settings from
 * a config file, so two players can never be sure they are running the exact
 * same state machine. This frontend exists so that a frame is a pure function:
 *
 *     new_state = run_frame(old_state, pad1, pad2)
 *
 * Nothing else is allowed in. No wall clock, no host RNG, no browser input, no
 * user-visible options. That is what makes ZSNES-style lockstep netplay
 * possible: both peers replay the identical frame sequence and stay bit-exact.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <time.h>

#include "libretro.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define PN_API EMSCRIPTEN_KEEPALIVE
#else
#define PN_API
#endif

/* snes9x can output 512x478 with hires + interlace. */
#define PN_MAX_WIDTH   512
#define PN_MAX_HEIGHT  512
#define PN_MAX_PIXELS  (PN_MAX_WIDTH * PN_MAX_HEIGHT)

/* One frame at 32040Hz is ~534 stereo samples; leave room for slow frames. */
#define PN_MAX_AUDIO_FRAMES 8192

#define PN_MAX_PORTS 2

/* Public API, declared up front so the definitions below can call each other
 * in any order. */
PN_API int       pn_init(void);
PN_API int       pn_load_rom(const uint8_t *data, int size);
PN_API void      pn_unload(void);
PN_API void      pn_reset(void);
PN_API void      pn_run_frame(uint16_t pad1, uint16_t pad2);
PN_API uint32_t *pn_video(void);
PN_API int       pn_video_width(void);
PN_API int       pn_video_height(void);
PN_API int       pn_video_stride(void);
PN_API int16_t  *pn_audio(void);
PN_API int       pn_audio_frames(void);
PN_API double    pn_sample_rate(void);
PN_API double    pn_fps(void);
PN_API uint32_t  pn_frame_count(void);
PN_API void      pn_set_frame_count(uint32_t frame);
PN_API int       pn_state_size(void);
PN_API int       pn_state_save(uint8_t *buf, int size);
PN_API int       pn_state_load(const uint8_t *buf, int size);
PN_API uint32_t  pn_state_crc(void);
PN_API uint8_t  *pn_sram(void);
PN_API int       pn_sram_size(void);
PN_API uint8_t  *pn_wram(void);
PN_API int       pn_wram_size(void);
PN_API uint32_t  pn_wram_crc(void);
PN_API int       pn_debug_rand(void);
PN_API double    pn_debug_time(void);
PN_API void      pn_debug_reset_entropy(void);

/* ------------------------------------------------------------------ state */

static uint32_t pn_framebuffer[PN_MAX_PIXELS];
static int      pn_fb_width  = 256;
static int      pn_fb_height = 224;

static int16_t  pn_audio_buffer[PN_MAX_AUDIO_FRAMES * 2];
static int      pn_audio_count; /* stereo frames written this emulated frame */

static uint16_t pn_pads[PN_MAX_PORTS];
static uint32_t pn_frame_index;
static int      pn_rom_loaded;
static int      pn_initialized;

static enum retro_pixel_format pn_pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;

/* Scratch buffer for pn_state_crc(), grown to the core's serialize size once. */
static uint8_t *pn_state_scratch;
static size_t   pn_state_scratch_size;

/* Kept alive for the whole session: retro_load_game() does not promise to copy
 * the ROM, and snes9x keeps pointers into it for some cart types. */
static uint8_t *pn_rom_copy;
static size_t   pn_rom_copy_size;

static int pn_log_enabled;

/* Implemented in determinism.c; puts the wrapped rand() back to its seed. */
void pn_reset_entropy(void);

/* ------------------------------------------------------------------- crc32 */

static uint32_t pn_crc_table[256];
static int      pn_crc_table_built;

static void pn_build_crc_table(void)
{
    uint32_t i, j, c;
    for (i = 0; i < 256; i++)
    {
        c = i;
        for (j = 0; j < 8; j++)
            c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
        pn_crc_table[i] = c;
    }
    pn_crc_table_built = 1;
}

static uint32_t pn_crc32(const uint8_t *data, size_t len)
{
    uint32_t crc = 0xFFFFFFFFu;
    size_t   i;
    if (!pn_crc_table_built)
        pn_build_crc_table();
    for (i = 0; i < len; i++)
        crc = pn_crc_table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
    return crc ^ 0xFFFFFFFFu;
}

/* --------------------------------------------------------- core variables */

/*
 * Every option is pinned here rather than read from a config file. Two peers
 * running different core options desync within seconds and the failure looks
 * exactly like a netcode bug, so the option set is part of the protocol.
 *
 * snes9x_randomize_memory matters most: with it enabled the core does
 * `srand(time(NULL))` and fills all 128KB of WRAM with rand(), which alone
 * guarantees two instances diverge the moment a game seeds its RNG from WRAM.
 */
struct pn_variable
{
    const char *key;
    const char *value;
};

static const struct pn_variable pn_variables[] = {
    { "snes9x_randomize_memory",          "disabled" },
    { "snes9x_up_down_allowed",           "disabled" },
    { "snes9x_overclock_cycles",          "disabled" },
    { "snes9x_reduce_sprite_flicker",     "disabled" },
    { "snes9x_hires_blend",               "disabled" },
    { "snes9x_audio_interpolation",       "gaussian" },
    { "snes9x_block_invalid_vram_access", "enabled"  },
    { "snes9x_echo_buffer_hack",          "disabled" },
    { "snes9x_overclock_superfx",         "100%"     },
    { "snes9x_superfx_timing",            "hardware" },
    { "snes9x_mode7_hires",               "disabled" },
    { "snes9x_gfx_clip",                  "enabled"  },
    { "snes9x_gfx_transp",                "enabled"  },
    { "snes9x_msu1_enhanced_audio",       "enabled"  },
    { NULL, NULL }
};

static const char *pn_lookup_variable(const char *key)
{
    const struct pn_variable *v;
    if (!key)
        return NULL;
    for (v = pn_variables; v->key; v++)
        if (!strcmp(v->key, key))
            return v->value;
    return NULL;
}

/* ------------------------------------------------------ libretro callbacks */

static void pn_log(enum retro_log_level level, const char *fmt, ...)
{
    (void)level;
    (void)fmt;
    /* Deliberately silent: core logging is noise in a 60Hz lockstep loop and
     * writing to stdout from wasm is surprisingly expensive. */
}

static bool pn_environment(unsigned cmd, void *data)
{
    switch (cmd)
    {
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        pn_pixel_format = *(const enum retro_pixel_format *)data;
        return true;

    case RETRO_ENVIRONMENT_GET_VARIABLE:
    {
        struct retro_variable *var = (struct retro_variable *)data;
        const char *value = pn_lookup_variable(var->key);
        if (!value)
        {
            /* Returning false leaves the core on its compiled-in default,
             * which is identical in every build of this wasm module. */
            var->value = NULL;
            return false;
        }
        var->value = value;
        return true;
    }

    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        *(bool *)data = false;
        return true;

    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
    {
        struct retro_log_callback *cb = (struct retro_log_callback *)data;
        cb->log = pn_log;
        return pn_log_enabled;
    }

    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
        /* Lets the core fetch a whole pad in one input_state_cb call, which is
         * exactly the shape our netplay packets already have. */
        return true;

    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        *(const char **)data = ".";
        return true;

    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
        return true;

    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    {
        const struct retro_game_geometry *geom =
            (const struct retro_game_geometry *)data;
        if (geom && geom->base_width && geom->base_height)
        {
            pn_fb_width  = (int)geom->base_width;
            pn_fb_height = (int)geom->base_height;
        }
        return true;
    }

    default:
        /* Anything we do not understand is refused, so the core falls back to
         * its most conservative path. Silence beats a half-supported feature
         * that behaves differently between two builds. */
        return false;
    }
}

static void pn_video_refresh(const void *data, unsigned width, unsigned height,
                             size_t pitch)
{
    unsigned x, y;

    if (!data || width == 0 || height == 0)
        return; /* duped frame: keep the previous framebuffer */

    if (width > PN_MAX_WIDTH)
        width = PN_MAX_WIDTH;
    if (height > PN_MAX_HEIGHT)
        height = PN_MAX_HEIGHT;

    pn_fb_width  = (int)width;
    pn_fb_height = (int)height;

    if (pn_pixel_format == RETRO_PIXEL_FORMAT_XRGB8888)
    {
        for (y = 0; y < height; y++)
        {
            const uint32_t *src = (const uint32_t *)((const uint8_t *)data + y * pitch);
            uint32_t *dst = pn_framebuffer + y * PN_MAX_WIDTH;
            for (x = 0; x < width; x++)
            {
                uint32_t p = src[x];
                /* XRGB8888 -> ABGR8888 (what a canvas ImageData expects). */
                dst[x] = 0xFF000000u
                       | ((p & 0x00FF0000u) >> 16)
                       | (p & 0x0000FF00u)
                       | ((p & 0x000000FFu) << 16);
            }
        }
        return;
    }

    for (y = 0; y < height; y++)
    {
        const uint16_t *src = (const uint16_t *)((const uint8_t *)data + y * pitch);
        uint32_t *dst = pn_framebuffer + y * PN_MAX_WIDTH;
        for (x = 0; x < width; x++)
        {
            uint16_t p = src[x];
            uint32_t r, g, b;
            if (pn_pixel_format == RETRO_PIXEL_FORMAT_RGB565)
            {
                r = (p >> 11) & 0x1F;
                g = (p >> 5)  & 0x3F;
                b = p         & 0x1F;
                g = (g << 2) | (g >> 4);
            }
            else /* 0RGB1555 */
            {
                r = (p >> 10) & 0x1F;
                g = (p >> 5)  & 0x1F;
                b = p         & 0x1F;
                g = (g << 3) | (g >> 2);
            }
            r = (r << 3) | (r >> 2);
            b = (b << 3) | (b >> 2);
            dst[x] = 0xFF000000u | (b << 16) | (g << 8) | r;
        }
    }
}

static void pn_audio_sample(int16_t left, int16_t right)
{
    if (pn_audio_count >= PN_MAX_AUDIO_FRAMES)
        return;
    pn_audio_buffer[pn_audio_count * 2]     = left;
    pn_audio_buffer[pn_audio_count * 2 + 1] = right;
    pn_audio_count++;
}

static size_t pn_audio_sample_batch(const int16_t *data, size_t frames)
{
    size_t room = (size_t)(PN_MAX_AUDIO_FRAMES - pn_audio_count);
    size_t n = frames < room ? frames : room;
    if (n)
    {
        memcpy(pn_audio_buffer + pn_audio_count * 2, data, n * 2 * sizeof(int16_t));
        pn_audio_count += (int)n;
    }
    return frames;
}

static void pn_input_poll(void)
{
    /* Intentionally empty. Pads are pushed in by the netplay layer before the
     * frame runs; the core never gets to look at the host machine. */
}

static int16_t pn_input_state(unsigned port, unsigned device, unsigned index,
                              unsigned id)
{
    (void)index;

    if (port >= PN_MAX_PORTS || device != RETRO_DEVICE_JOYPAD)
        return 0;

    if (id == RETRO_DEVICE_ID_JOYPAD_MASK)
        return (int16_t)pn_pads[port];

    if (id > 15)
        return 0;

    return (pn_pads[port] >> id) & 1;
}

/* ------------------------------------------------------------- public API */

PN_API int pn_init(void)
{
    if (pn_initialized)
        return 1;

    retro_set_environment(pn_environment);
    retro_set_video_refresh(pn_video_refresh);
    retro_set_audio_sample(pn_audio_sample);
    retro_set_audio_sample_batch(pn_audio_sample_batch);
    retro_set_input_poll(pn_input_poll);
    retro_set_input_state(pn_input_state);

    retro_init();

    retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
    retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD);

    pn_initialized = 1;
    return 1;
}

PN_API int pn_load_rom(const uint8_t *data, int size)
{
    struct retro_game_info info;
    bool ok;

    if (!pn_initialized || !data || size <= 0)
        return 0;

    if (pn_rom_loaded)
        pn_unload();

    /* retro_load_game() is where the core draws on host entropy, so the
     * generator is rewound first: loading the same ROM twice must produce
     * byte-identical machines. */
    pn_reset_entropy();

    pn_rom_copy = (uint8_t *)malloc((size_t)size);
    if (!pn_rom_copy)
        return 0;
    memcpy(pn_rom_copy, data, (size_t)size);
    pn_rom_copy_size = (size_t)size;

    memset(&info, 0, sizeof(info));
    info.path = NULL;
    info.data = pn_rom_copy;
    info.size = pn_rom_copy_size;
    info.meta = NULL;

    ok = retro_load_game(&info);
    if (!ok)
    {
        free(pn_rom_copy);
        pn_rom_copy = NULL;
        pn_rom_copy_size = 0;
        return 0;
    }

    pn_rom_loaded  = 1;
    pn_frame_index = 0;
    pn_pads[0] = pn_pads[1] = 0;
    pn_audio_count = 0;
    return 1;
}

PN_API void pn_unload(void)
{
    if (!pn_rom_loaded)
        return;
    retro_unload_game();
    free(pn_rom_copy);
    pn_rom_copy = NULL;
    pn_rom_copy_size = 0;
    pn_rom_loaded = 0;
}

PN_API void pn_reset(void)
{
    if (!pn_rom_loaded)
        return;
    retro_reset();
    pn_frame_index = 0;
}

/*
 * The only way to advance emulation. Pads are 12-bit libretro joypad masks
 * (bit N = RETRO_DEVICE_ID_JOYPAD_N), which is the same encoding the netplay
 * packets carry, so no translation happens anywhere in the pipeline.
 */
PN_API void pn_run_frame(uint16_t pad1, uint16_t pad2)
{
    if (!pn_rom_loaded)
        return;
    pn_pads[0] = pad1;
    pn_pads[1] = pad2;
    pn_audio_count = 0;
    retro_run();
    pn_frame_index++;
}

PN_API uint32_t *pn_video(void)         { return pn_framebuffer; }
PN_API int       pn_video_width(void)   { return pn_fb_width; }
PN_API int       pn_video_height(void)  { return pn_fb_height; }
PN_API int       pn_video_stride(void)  { return PN_MAX_WIDTH; }

PN_API int16_t  *pn_audio(void)         { return pn_audio_buffer; }
PN_API int       pn_audio_frames(void)  { return pn_audio_count; }

PN_API uint32_t  pn_frame_count(void)   { return pn_frame_index; }
PN_API void      pn_set_frame_count(uint32_t f) { pn_frame_index = f; }

PN_API double pn_sample_rate(void)
{
    struct retro_system_av_info av;
    memset(&av, 0, sizeof(av));
    retro_get_system_av_info(&av);
    return av.timing.sample_rate;
}

PN_API double pn_fps(void)
{
    struct retro_system_av_info av;
    memset(&av, 0, sizeof(av));
    retro_get_system_av_info(&av);
    return av.timing.fps;
}

PN_API int pn_state_size(void)
{
    if (!pn_rom_loaded)
        return 0;
    return (int)retro_serialize_size();
}

PN_API int pn_state_save(uint8_t *buf, int size)
{
    size_t need;
    if (!pn_rom_loaded || !buf)
        return 0;
    need = retro_serialize_size();
    if ((size_t)size < need)
        return 0;
    return retro_serialize(buf, need) ? (int)need : 0;
}

PN_API int pn_state_load(const uint8_t *buf, int size)
{
    if (!pn_rom_loaded || !buf || size <= 0)
        return 0;
    return retro_unserialize(buf, (size_t)size) ? 1 : 0;
}

/*
 * CRC32 of the serialized core state. This is the desync detector: it covers
 * exactly what a savestate covers, so a mismatch means the two peers really
 * are running different machines - unlike hashing raw wasm memory, which also
 * picks up allocator noise and video scratch and cries wolf.
 */
PN_API uint32_t pn_state_crc(void)
{
    size_t need;

    if (!pn_rom_loaded)
        return 0;

    need = retro_serialize_size();
    if (need == 0)
        return 0;

    if (need > pn_state_scratch_size)
    {
        uint8_t *grown = (uint8_t *)realloc(pn_state_scratch, need);
        if (!grown)
            return 0;
        pn_state_scratch = grown;
        pn_state_scratch_size = need;
    }

    if (!retro_serialize(pn_state_scratch, need))
        return 0;

    return pn_crc32(pn_state_scratch, need);
}

PN_API uint8_t *pn_sram(void)
{
    return (uint8_t *)retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
}

PN_API int pn_sram_size(void)
{
    return (int)retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);
}

PN_API uint8_t *pn_wram(void)
{
    return (uint8_t *)retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM);
}

PN_API int pn_wram_size(void)
{
    return (int)retro_get_memory_size(RETRO_MEMORY_SYSTEM_RAM);
}

/*
 * Cheap per-frame checksum over work RAM. Serializing the whole machine every
 * frame costs milliseconds; hashing 128KB costs microseconds, which is what
 * makes frame-by-frame divergence hunting practical in the test suite.
 */
PN_API uint32_t pn_wram_crc(void)
{
    const uint8_t *ram = pn_wram();
    int size = pn_wram_size();
    if (!ram || size <= 0)
        return 0;
    return pn_crc32(ram, (size_t)size);
}

/*
 * Test hooks. The netplay guarantee rests on the entropy shims actually being
 * linked in, so the suite checks the shims directly rather than inferring it
 * from emulation staying in sync.
 */
PN_API int pn_debug_rand(void)
{
    return rand();
}

PN_API double pn_debug_time(void)
{
    /* double, not time_t: the value crosses into JS, and time_t is 64-bit
     * here while JS numbers are not. */
    return (double)time(NULL);
}

PN_API void pn_debug_reset_entropy(void)
{
    pn_reset_entropy();
}

int main(void)
{
    /* Nothing runs at startup; the JS side calls pn_init() explicitly. */
    return 0;
}
