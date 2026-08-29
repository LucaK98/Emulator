@
@ Game Boy Advance probe for the depth decoder.
@
@ Sets up the arrangement a tile-based game actually uses, so the decoder can
@ be checked against the emulator's own picture with nothing in the way:
@
@   * mode 0, the text mode where every background layer is a scrolling map
@   * BG1 as the world: scrolled off the tile grid in both axes, so a decoder
@     that ignores the scroll or rounds it lands visibly wrong
@   * BG0 pinned at scroll zero as furniture, drawn in front of BG1, with a
@     transparent lower half so the layer behind it must show through
@   * two palettes in use, so a decoder that assumes palette zero fails
@   * three objects of different sizes and flips, one behind the background
@
@ Deliberately absent: blending, windows, mosaic and affine layers. Those are
@ effects the depth renderer does not model either, and including them would
@ make the comparison meaningless rather than strict.
@
@ Assembled and packed by scripts/build-gba-probe.py.

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
    ldr     r3, =0x07000000         @ OAM

    @ --- Palettes ---------------------------------------------------------
    @ Background palette 0: black, then three flat colours.
    adr     r4, bg_palette0
    add     r5, r1, #0
    bl      copy_16_halfwords
    @ Background palette 1 sits sixteen entries further along.
    adr     r4, bg_palette1
    add     r5, r1, #32
    bl      copy_16_halfwords
    @ Object palette 0 lives in the second half of palette RAM.
    adr     r4, obj_palette0
    add     r5, r1, #0x200
    bl      copy_16_halfwords

    @ --- Background tiles at character base 0 -----------------------------
    adr     r4, tiles
    add     r5, r2, #0
    mov     r6, #4 * 32 / 4         @ four tiles, 32 bytes each
    bl      copy_words

    @ --- Object tiles at 0x06010000 ---------------------------------------
    adr     r4, obj_tiles
    ldr     r5, =0x06010000
    mov     r6, #12 * 32 / 4        @ twelve tiles: 8x8, 16x16 and 32x16
    bl      copy_words

    @ --- BG1's map, screen base block 8 -----------------------------------
    @ A repeating pattern of three tiles so neighbouring cells differ and a
    @ decoder that mixes up map rows and columns shows it.
    ldr     r5, =0x06004000
    mov     r7, #0                  @ row
map1_row:
    mov     r8, #0                  @ column
map1_col:
    and     r9, r7, #3
    add     r9, r9, r8
    and     r9, r9, #3
    add     r9, r9, #1              @ tiles 1..4, never the empty tile 0
    cmp     r9, #4
    movge   r9, #3
    strh    r9, [r5], #2
    add     r8, r8, #1
    cmp     r8, #32
    blt     map1_col
    add     r7, r7, #1
    cmp     r7, #32
    blt     map1_row

    @ --- BG0's map, screen base block 9 -----------------------------------
    @ The top six rows carry tile 2 in palette 1; everything below is the
    @ empty tile, so BG1 has to show through.
    ldr     r5, =0x06004800
    ldr     r12, =0x1002            @ palette 1, tile 2 — too wide for an immediate
    mov     r7, #0
map0_row:
    mov     r8, #0
map0_col:
    cmp     r7, #6
    movlt   r9, r12                 @ palette 1 (bits 12-15), tile 2
    movge   r9, #0
    strh    r9, [r5], #2
    add     r8, r8, #1
    cmp     r8, #32
    blt     map0_col
    add     r7, r7, #1
    cmp     r7, #32
    blt     map0_row

    @ --- Objects ----------------------------------------------------------
    @ Object memory comes up holding whatever was there. Disable all 128 first
    @ so the probe shows only the three it means to.
    mov     r5, r3
    mov     r6, #128
    mov     r7, #0x0200             @ attr0 bit 9: not affine, not displayed
clear_oam:
    strh    r7, [r5], #2
    add     r5, r5, #6
    subs    r6, r6, #1
    bne     clear_oam

    adr     r4, objects
    mov     r5, r3
    mov     r6, #3
obj_loop:
    ldrh    r7, [r4], #2
    strh    r7, [r5], #2
    ldrh    r7, [r4], #2
    strh    r7, [r5], #2
    ldrh    r7, [r4], #2
    strh    r7, [r5], #2
    add     r5, r5, #2              @ the fourth halfword is affine data
    subs    r6, r6, #1
    bne     obj_loop

    @ --- Layer control ----------------------------------------------------
    @ BG0: priority 0, char base 0, screen base 9, sixteen colours, 32x32.
    mov     r7, #0x0900
    strh    r7, [r0, #8]
    @ BG1: priority 1, char base 0, screen base 8.
    ldr     r7, =0x0801
    strh    r7, [r0, #10]

    @ BG0 stays at zero: that is what marks it as furniture rather than world.
    mov     r7, #0
    strh    r7, [r0, #0x10]
    strh    r7, [r0, #0x12]
    @ BG1 scrolled off the grid in both axes.
    mov     r7, #13
    strh    r7, [r0, #0x14]
    mov     r7, #6
    strh    r7, [r0, #0x16]

    @ Mode 0, BG0 and BG1 and objects on, objects mapped one-dimensionally.
    ldr     r7, =0x1340
    strh    r7, [r0]

hang:
    b       hang

@ --- Helpers -------------------------------------------------------------

@ r4 = source, r5 = destination; copies sixteen halfwords.
copy_16_halfwords:
    mov     r10, #16
1:  ldrh    r11, [r4], #2
    strh    r11, [r5], #2
    subs    r10, r10, #1
    bne     1b
    bx      lr

@ r4 = source, r5 = destination, r6 = word count.
copy_words:
    ldr     r11, [r4], #4
    str     r11, [r5], #4
    subs    r6, r6, #1
    bne     copy_words
    bx      lr

@ --- Data ----------------------------------------------------------------

    .align 2
bg_palette0:
    .hword 0x0000, 0x001F, 0x03E0, 0x7C00, 0x7FFF, 0x03FF, 0x7C1F, 0x7FE0
    .hword 0x0010, 0x0200, 0x4000, 0x4210, 0x2108, 0x001A, 0x0340, 0x6800

bg_palette1:
    .hword 0x0000, 0x7FE0, 0x421F, 0x03E0, 0x7C00, 0x001F, 0x7FFF, 0x0000
    .hword 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000

obj_palette0:
    .hword 0x0000, 0x7C1F, 0x03FF, 0x7FFF, 0x001F, 0x03E0, 0x7C00, 0x7FE0
    .hword 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000

@ Four background tiles, sixteen colours, two pixels a byte, low nibble first.
tiles:
    @ 0: entirely transparent
    .word 0, 0, 0, 0, 0, 0, 0, 0
    @ 1: flat colour 1
    .word 0x11111111, 0x11111111, 0x11111111, 0x11111111
    .word 0x11111111, 0x11111111, 0x11111111, 0x11111111
    @ 2: flat colour 2
    .word 0x22222222, 0x22222222, 0x22222222, 0x22222222
    .word 0x22222222, 0x22222222, 0x22222222, 0x22222222
    @ 3: alternating rows of colours 3 and 4, so flips are visible
    .word 0x33333333, 0x33333333, 0x44444444, 0x44444444
    .word 0x33333333, 0x33333333, 0x44444444, 0x44444444

@ Object tiles: one 8x8, then four for a 16x16, then eight for a 32x16.
obj_tiles:
    .word 0x11111111, 0x11111111, 0x11111111, 0x11111111
    .word 0x11111111, 0x11111111, 0x10000001, 0x11111111
    .rept 4
    .word 0x22222222, 0x22222222, 0x22222222, 0x22222222
    .word 0x22222222, 0x22222222, 0x22222222, 0x22222222
    .endr
    .rept 8
    .word 0x33333333, 0x33333333, 0x33333333, 0x33333333
    .word 0x33333333, 0x33333333, 0x33333333, 0x33333333
    .endr

@ Three objects, three halfwords each: attr0, attr1, attr2.
@   attr0: y | shape<<14
@   attr1: x | flip<<12 | size<<14
@   attr2: tile | priority<<10 | palette<<12
objects:
    @ 8x8 at (24, 30), tile 0. Priority 0, so it sits in front of every layer:
    @ an object only beats a background whose priority number is no lower.
    .hword 30, 24, 0
    @ 16x16 at (70, 60), flipped horizontally, tile 1, also in front.
    .hword 60, (70 | (1 << 12) | (1 << 14)), 1
    @ 32x16 behind the background at (140, 90), tile 5. Wide shape, size 2.
    .hword (90 | (1 << 14)), (140 | (2 << 14)), (5 | (3 << 10))
