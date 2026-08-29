@
@ Game Boy Advance probe for measuring which way the picture is travelling.
@
@ The overworld probe cannot serve here. Its map repeats every tile, so
@ matching two pictures against each other only ever determines the shift
@ modulo eight pixels — the direction of travel is not recoverable from it at
@ all, and a test that appeared to read it was reading noise.
@
@ This one scrolls a single background one pixel per frame, over a map whose
@ columns cycle through sixteen distinguishable tiles. The picture therefore
@ repeats only every 128 pixels, far outside the range any measurement here
@ searches, so a shift of a few pixels has exactly one answer and its sign is
@ the direction of travel.
@
@ Assembled by scripts/build-gba-scroll-probe.py.

    .arm
    .section .text.boot, "ax"
    .global _start

_start:
    b       main
    .space  0xC0 - 4, 0

main:
    ldr     r0, =0x04000000         @ I/O base
    ldr     r1, =0x05000000         @ palette RAM
    ldr     r2, =0x06000000         @ VRAM

    @ --- Palette: sixteen clearly different colours ------------------------
    adr     r4, palette
    mov     r5, r1
    mov     r6, #16
1:  ldrh    r7, [r4], #2
    strh    r7, [r5], #2
    subs    r6, r6, #1
    bne     1b

    @ --- Sixteen tiles, each filled with one colour ------------------------
    @ Tile n is solid colour n, so a column of the map is identifiable by its
    @ colour alone and no filtering or scaling can confuse two of them.
    mov     r5, r2                  @ character base 0
    mov     r8, #0                  @ colour
tile_loop:
    @ One tile is eight rows of four bytes; every nibble is the colour.
    mov     r9, r8
    orr     r9, r9, r9, lsl #4
    orr     r9, r9, r9, lsl #8
    orr     r9, r9, r9, lsl #16
    mov     r6, #8
2:  str     r9, [r5], #4
    str     r9, [r5], #4
    subs    r6, r6, #1
    bne     2b
    add     r8, r8, #1
    cmp     r8, #16
    blt     tile_loop

    @ --- Map at screen base block 8 ---------------------------------------
    @ Column c holds tile c mod 16, so the picture repeats only every sixteen
    @ tiles — 128 pixels, and nothing here measures that far.
    ldr     r5, =0x06004000
    mov     r7, #0                  @ row
map_row:
    mov     r8, #0                  @ column
map_col:
    and     r9, r8, #15
    strh    r9, [r5], #2
    add     r8, r8, #1
    cmp     r8, #32
    blt     map_col
    add     r7, r7, #1
    cmp     r7, #32
    blt     map_row

    @ --- Layer and display -------------------------------------------------
    @ BG0: priority 0, char base 0, screen base 8, sixteen colours, 32x32.
    ldr     r7, =0x0800
    strh    r7, [r0, #8]
    @ Mode 0 with BG0 on.
    ldr     r7, =0x0100
    strh    r7, [r0]

    @ --- One pixel of scroll per frame -------------------------------------
    mov     r10, #0                 @ scroll position
frame_loop:
    @ Wait for the line counter to leave the visible area, then to re-enter
    @ it: one pass of the pair is exactly one frame.
    add     r11, r0, #6             @ the line counter
3:  ldrh    r12, [r11]
    cmp     r12, #160
    blt     3b
4:  ldrh    r12, [r11]
    cmp     r12, #160
    bge     4b

    add     r10, r10, #1
    strh    r10, [r0, #0x10]        @ BG0 horizontal scroll
    b       frame_loop

    .align 2
palette:
    .hword 0x0000, 0x001F, 0x03E0, 0x7C00, 0x7FFF, 0x03FF, 0x7C1F, 0x7FE0
    .hword 0x0010, 0x0200, 0x4000, 0x4210, 0x2108, 0x001A, 0x0340, 0x6800
