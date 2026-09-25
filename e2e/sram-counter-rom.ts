/**
 * A 32 KiB LoROM, written here byte by byte, whose only job is to count its
 * own boots in battery RAM.
 *
 * The repository ships no ROM - they are the players' own files, and none may
 * be committed - so a test that needs one either skips or makes one. This one
 * makes one, because what it has to prove is exactly the thing a skip would
 * hide: that the battery save written on one visit is the one read back on
 * the next, with the network cut.
 *
 * The program, at $00:8000 (file offset 0):
 *
 *     sei                 ; 78
 *     clc                 ; 18
 *     xce                 ; FB        native mode, A still 8-bit
 *     stz $2121           ; 9C 21 21  palette entry 0: the backdrop
 *     lda #$0A            ; A9 0A
 *     sta $2122           ; 8D 22 21
 *     lda #$65            ; A9 65
 *     sta $2122           ; 8D 22 21  #5647cb, the app's purple, in BGR555
 *     lda #$0F            ; A9 0F
 *     sta $2100           ; 8D 00 21  screen on, full brightness
 *     lda $700000         ; AF 00 00 70
 *     inc a               ; 1A
 *     sta $700000         ; 8F 00 00 70
 *   loop: bra loop        ; 80 FE
 *
 * The backdrop is only there so a screenshot shows a machine that runs: a
 * program that draws nothing looks exactly like a core that never started.
 *
 * $70:0000 is the first byte of cartridge SRAM on a LoROM board. Each boot
 * therefore leaves byte 0 of the `.srm` one higher than the save it booted
 * from: a second session that finds the first one's progress reads N+1, and
 * one that starts from a blank save reads the blank value plus one again.
 */

const SIZE = 0x8000;
const HEADER = 0x7fc0;

export function sramCounterRom(): Uint8Array {
	const rom = new Uint8Array(SIZE);

	const program = [
		0x78, 0x18, 0xfb,
		0x9c, 0x21, 0x21,
		0xa9, 0x0a, 0x8d, 0x22, 0x21,
		0xa9, 0x65, 0x8d, 0x22, 0x21,
		0xa9, 0x0f, 0x8d, 0x00, 0x21,
		0xaf, 0x00, 0x00, 0x70, 0x1a, 0x8f, 0x00, 0x00, 0x70,
		0x80, 0xfe
	];
	rom.set(program, 0);
	// An RTI for every interrupt vector: none is enabled, but a vector into
	// zeroes would be a BRK loop if one ever fired.
	const RTI_AT = 0x0040;
	rom[RTI_AT] = 0x40;

	const title = 'PSNES SRAM COUNTER'.padEnd(21, ' ');
	for (let i = 0; i < 21; i++) rom[HEADER + i] = title.charCodeAt(i);
	rom[HEADER + 0x15] = 0x20; // LoROM
	rom[HEADER + 0x16] = 0x02; // ROM + RAM + battery
	rom[HEADER + 0x17] = 0x05; // 32 KiB of ROM
	rom[HEADER + 0x18] = 0x01; // 2 KiB of SRAM
	rom[HEADER + 0x19] = 0x01; // North America
	rom[HEADER + 0x1a] = 0x33;
	rom[HEADER + 0x1b] = 0x00;

	const vector = (offset: number, address: number) => {
		rom[offset] = address & 0xff;
		rom[offset + 1] = address >> 8;
	};
	const rti = 0x8000 + RTI_AT;
	// Native: COP, BRK, ABORT, NMI, (unused), IRQ.
	for (const at of [0x7fe4, 0x7fe6, 0x7fe8, 0x7fea, 0x7fee]) vector(at, rti);
	// Emulation: COP, ABORT, NMI, RESET, IRQ/BRK.
	for (const at of [0x7ff4, 0x7ff8, 0x7ffa, 0x7ffe]) vector(at, rti);
	vector(0x7ffc, 0x8000);

	// The checksum pair, which header-scoring emulators weigh: summed with a
	// placeholder complement/checksum of FFFF/0000, whose bytes sum to what
	// any real pair does.
	rom[HEADER + 0x1c] = 0xff;
	rom[HEADER + 0x1d] = 0xff;
	let sum = 0;
	for (const byte of rom) sum = (sum + byte) & 0xffff;
	vector(HEADER + 0x1e, sum);
	vector(HEADER + 0x1c, sum ^ 0xffff);

	return rom;
}
