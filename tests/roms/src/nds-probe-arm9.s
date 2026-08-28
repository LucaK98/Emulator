@ nds-probe, ARM9 side.
@
@ Draws something different on each screen, so the wrapper's screen compositing
@ and its stacked/side-by-side layouts can be told apart at a glance:
@
@   * the engine A screen shows a two-axis colour gradient, written straight
@     into VRAM bank A in bitmap display mode;
@   * the engine B screen shows a flat colour from its backdrop palette entry.
@
@ Assembled with arm-none-eabi-gcc; see tests/roms/README.md.

    .arm
    .section .text
    .global _start

    .equ POWCNT1,   0x04000304
    .equ DISPCNT_A, 0x04000000
    .equ DISPCNT_B, 0x04001000
    .equ VRAMCNT_A, 0x04000240
    .equ PALETTE_B, 0x05000400
    .equ VRAM_A,    0x06800000
    .equ PIXELS,    256 * 192

_start:
    @ LCDs on, both 2D engines on, engine A on the upper screen.
    ldr r0, =POWCNT1
    ldr r1, =0x8203
    str r1, [r0]

    @ VRAM bank A in LCDC mode, so it can be displayed directly.
    ldr r0, =VRAMCNT_A
    mov r1, #0x80
    strb r1, [r0]

    @ Engine A: VRAM display mode, i.e. show bank A as a 15-bit bitmap.
    ldr r0, =DISPCNT_A
    ldr r1, =0x00020000
    str r1, [r0]

    @ Engine B: graphics display, mode 0, every layer off — what remains is the
    @ backdrop. Display mode 0 would blank the screen to white instead.
    ldr r0, =DISPCNT_B
    ldr r1, =0x00010000
    str r1, [r0]

    @ Backdrop colour for engine B: a strong blue, unmistakable next to the
    @ gradient on the other screen.
    ldr r0, =PALETTE_B
    ldr r1, =0x7C00
    strh r1, [r0]

    @ Fill the bitmap: red along x, green along y.
    ldr r0, =VRAM_A
    mov r2, #0
    ldr r3, =PIXELS

fill:
    and r1, r2, #0x1F           @ x within a 32-pixel band -> red
    mov r4, r2, lsr #8          @ row -> green
    and r4, r4, #0x1F
    orr r1, r1, r4, lsl #5
    orr r1, r1, #0x8000         @ opaque
    strh r1, [r0], #2
    add r2, r2, #1
    cmp r2, r3
    bne fill

hang:
    b hang
