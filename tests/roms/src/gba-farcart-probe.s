@
@ Game Boy Advance probe: proves the cartridge stays mapped, all of it.
@
@ mGBA does not copy a GBA ROM, it maps it: every cartridge read the game makes
@ goes to the buffer handed to loadROM. If that buffer is released after the
@ load call, small test ROMs keep working by luck — the freed bytes are still
@ sitting there untouched, and a tiny ROM never reads past its own first few
@ kilobytes. Only a cartridge that reads far from its start notices.
@
@ So this one does exactly that: the palette it displays is not stored near the
@ code, it is read from four widely spread offsets across a 16 MiB cartridge —
@ 4, 8, 12 and just under 16 MiB in. The screen is split into four bands, one
@ per marker, each filled with the colour that marker encodes.
@
@ Correct output is four distinct, saturated bands: red, green, blue, white.
@ A cartridge that is no longer mapped yields whatever the freed memory now
@ holds — in practice zeroes, so black, or a single wrong colour.
@
@ Assembled by scripts/build-gba-probe.py, which also writes the header and
@ places the markers.

    .arm
    .section .text.boot, "ax"
    .global _start

_start:
    b       main
    @ The 156-byte Nintendo logo and the rest of the header are written by the
    @ packer; this reserves the room for it.
    .space  0xC0 - 4, 0

main:
    @ DISPCNT = mode 3, background 2 on: a plain 240x160 16-bit bitmap, which
    @ needs no tiles, no palette and no DMA to show something.
    ldr     r0, =0x04000000
    ldr     r1, =0x0403            @ mode 3 | BG2
    str     r1, [r0]

    ldr     r4, =0x06000000        @ VRAM: one halfword per pixel, XBGR1555
    ldr     r5, =marker_table      @ four pointers into far cartridge space
    mov     r6, #0                 @ band index

band_loop:
    ldr     r7, [r5, r6, lsl #2]   @ address of this band's marker
    ldrh    r8, [r7]               @ the colour it encodes

    @ Each band is 40 rows of 240 pixels.
    mov     r9, #40 * 240
fill:
    strh    r8, [r4], #2
    subs    r9, r9, #1
    bne     fill

    add     r6, r6, #1
    cmp     r6, #4
    blt     band_loop

hang:
    b       hang

    .align 2
marker_table:
    .word   0x08400000             @  4 MiB in
    .word   0x08800000             @  8 MiB in
    .word   0x08C00000             @ 12 MiB in
    .word   0x08FF0000             @ just under 16 MiB in
