# Dual WasmEmulator Sync Test

This test verifies that two independent WasmEmulator instances can maintain perfect synchronization when running the same ROM with the same inputs.

## Purpose

Tests deterministic behavior of the emulator by:
1. Creating two independent WasmEmulator instances
2. Loading the same ROM in both
3. Syncing initial state from Emulator A to Emulator B
4. Advancing both emulators frame-by-frame
5. Comparing SHA-256 checksums of their states at regular intervals

## Running the Test

### Option 1: Shell Script (Recommended)

```bash
cd sync-test
./run-test.sh
```

Then open http://localhost:9999/ in your browser.

### Option 2: Manual Start

```bash
cd sync-test
npm run dev
```

Then open http://localhost:9999/ in your browser.

### Option 3: Headless with Puppeteer (requires Chrome dependencies)

```bash
cd sync-test
npm test
# or for headless:
npm run test:headless
```

## Test Interface

The test page shows:
- **Emulator A (Primary)**: The reference emulator
- **Emulator B (Synced Clone)**: Synchronized from A's state

### Controls

- **Start Full Test**: Runs the complete test sequence (300 frames)
- **Stop**: Interrupts the test
- **Compare Checksums**: Manually trigger a checksum comparison
- **+1/+10/+60 Frame**: Advance both emulators by N frames
- **Sync B → A**: Re-synchronize B to match A's current state

### Statistics

- **Total Frames**: Number of frames executed
- **Sync Checks**: Number of checksum comparisons performed
- **Matches**: Times checksums matched (emulators in sync)
- **Mismatches**: Times checksums differed (desync detected)

## Expected Results

A passing test shows:
- All checksum comparisons match
- No mismatches detected
- Both emulators maintain identical state throughout

## Technical Details

### Test ROM

Uses a minimal 32KB SNES ROM that:
- Initializes the SNES to native mode
- Runs an infinite NOP loop
- No audio, no complex graphics
- Deterministic by design

### Checksum Algorithm

Uses SHA-256 hash of the full emulator savestate, truncated to 64 bits for display.

### Dependencies

The test requires the WasmEmulator code from `../frontend/src/lib/emulator/` and loads the snes9x RetroArch core from a CDN.
