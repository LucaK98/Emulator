@
@ Game Boy Advance counterpart to overworld-probe.gb: a miniature overworld
@ for the height model.
@
@ The model is told nothing about any game. It works out which background
@ tiles are ground by watching where characters can be: a tile a character has
@ stood on is floor, a familiar tile nobody ever stands on is a tree, a wall, a
@ cliff. Until now that was only ever exercised on the Game Boy, so the whole
@ path — four layers, sixteen-colour tiles, object attributes — went untested
@ on the console the feature was actually asked for.
@
@ So this cartridge builds the situation the model is meant to read:
@
@   * one scrolling background of ground tiles with scenery scattered through
@     it, moving a pixel a frame so the camera really travels
@   * one object whose feet stay in map row 11, which is ground for its whole
@     width — so every tile the character can reach is ground
@   * the scenery tile appears everywhere except that row, so nothing ever
@     stands on it
@
@ Correct behaviour is that the scenery tile rises and the ground tiles stay
@ flat, with nothing in the cartridge saying which is which.
@
@ Assembled by scripts/build-gba-overworld-probe.py.

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
    ldr     r3, =0x07000000         @ object memory

    @ --- Palettes ----------------------------------------------------------
    adr     r4, bg_palette
    mov     r5, r1
    mov     r6, #16
1:  ldrh    r7, [r4], #2
    strh    r7, [r5], #2
    subs    r6, r6, #1
    bne     1b

    adr     r4, obj_palette
    add     r5, r1, #0x200
    mov     r6, #16
2:  ldrh    r7, [r4], #2
    strh    r7, [r5], #2
    subs    r6, r6, #1
    bne     2b

    @ --- Four background tiles, each a flat colour -------------------------
    @ Tile n is solid colour n, so a tile is identifiable by its colour alone.
    mov     r5, r2                  @ character base 0
    mov     r8, #0
tile_loop:
    mov     r9, r8
    orr     r9, r9, r9, lsl #4
    orr     r9, r9, r9, lsl #8
    orr     r9, r9, r9, lsl #16
    mov     r6, #8
3:  str     r9, [r5], #4
    str     r9, [r5], #4
    subs    r6, r6, #1
    bne     3b
    add     r8, r8, #1
    cmp     r8, #4
    blt     tile_loop

    @ --- Object tiles: four of them, making one 16x16 character ------------
    ldr     r5, =0x06010000
    mov     r9, #0x11
    orr     r9, r9, r9, lsl #8
    orr     r9, r9, r9, lsl #16
    mov     r6, #4 * 8              @ four tiles of eight rows
4:  str     r9, [r5], #4
    str     r9, [r5], #4
    subs    r6, r6, #1
    bne     4b

    @ --- The map, at screen base block 8 -----------------------------------
    @ Row 11 is the row the character's feet fall in, so it is ground for its
    @ whole width. Everywhere else, every third cell is scenery.
    ldr     r5, =0x06004000
    mov     r10, #0                 @ cycles 0,1,2 across the whole map
    mov     r7, #0                  @ row
map_row:
    mov     r8, #0                  @ column
map_col:
    cmp     r7, #11
    moveq   r9, r8
    andeq   r9, r9, #1
    addeq   r9, r9, #1              @ the walk row: ground tiles 1 and 2
    beq     store_cell
    cmp     r10, #0
    moveq   r9, #3                  @ scenery
    movne   r9, #1                  @ ground
store_cell:
    strh    r9, [r5], #2
    add     r10, r10, #1
    cmp     r10, #3
    movge   r10, #0
    add     r8, r8, #1
    cmp     r8, #32
    blt     map_col
    add     r7, r7, #1
    cmp     r7, #32
    blt     map_row

    @ --- Objects -----------------------------------------------------------
    @ Object memory comes up holding whatever was there; disable all of it
    @ first so only the character below is shown.
    mov     r5, r3
    mov     r6, #128
    mov     r7, #0x0200             @ attr0 bit 9: not affine, not displayed
clear_oam:
    strh    r7, [r5], #2
    add     r5, r5, #6
    subs    r6, r6, #1
    bne     clear_oam

    @ One 16x16 character at (112, 80). Its feet land two pixels above its
    @ bottom edge, at y 94 — inside map row 11.
    mov     r5, r3
    mov     r7, #80                 @ attr0: y, square, sixteen colours
    strh    r7, [r5], #2
    ldr     r7, =0x4070             @ attr1: x = 112, size 1 -> 16x16
    strh    r7, [r5], #2
    mov     r7, #0                  @ attr2: object tile 0, palette 0
    strh    r7, [r5], #2

    @ --- Layer and display -------------------------------------------------
    @ BG0: priority 1, char base 0, screen base 8, sixteen colours, 32x32.
    ldr     r7, =0x0801
    strh    r7, [r0, #8]

    @ The scroll starts at one rather than zero: a layer sitting at exactly
    @ zero and never moving is what marks furniture, and this one is world.
    mov     r7, #1
    strh    r7, [r0, #0x10]
    mov     r7, #0
    strh    r7, [r0, #0x12]

    @ Mode 0, BG0 and objects on, object tiles mapped one-dimensionally.
    ldr     r7, =0x1140
    strh    r7, [r0]

    @ --- One pixel of scroll per frame -------------------------------------
    mov     r10, #1
frame_loop:
    add     r11, r0, #6             @ the line counter
5:  ldrh    r12, [r11]
    cmp     r12, #160
    blt     5b
6:  ldrh    r12, [r11]
    cmp     r12, #160
    bge     6b

    add     r10, r10, #1
    strh    r10, [r0, #0x10]        @ BG0 horizontal scroll
    b       frame_loop

    .align 2
    @ Colour 1 is the ground, 2 its second shade, 3 the scenery.
bg_palette:
    .hword 0x0000, 0x2E4A, 0x3A8C, 0x0140, 0x7FFF, 0x03FF, 0x7C1F, 0x7FE0
    .hword 0x0010, 0x0200, 0x4000, 0x4210, 0x2108, 0x001A, 0x0340, 0x6800

obj_palette:
    .hword 0x0000, 0x7C1F, 0x03FF, 0x7FFF, 0x001F, 0x03E0, 0x7C00, 0x7FE0
    .hword 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000
