; ppu-probe — a purpose-built oracle for the PPU layer decoder.
;
; Draws a scene that exercises exactly the paths the 2.5D renderer depends on
; and that a text-only test ROM leaves untouched:
;
;   * signed ($8800) background tile addressing
;   * a background scrolled by a non-multiple of 8 in both axes
;   * a window at a non-zero origin, using the second tile map
;   * 8x16 sprites, both object palettes, X and Y flips, and one sprite behind
;     the background
;
; The suite decodes VRAM/OAM back into layers, composites them, and requires
; the result to match the emulator's own output pixel for pixel.

DEF rLCDC EQU $FF40
DEF rSTAT EQU $FF41
DEF rSCY  EQU $FF42
DEF rSCX  EQU $FF43
DEF rLY   EQU $FF44
DEF rBGP  EQU $FF47
DEF rOBP0 EQU $FF48
DEF rOBP1 EQU $FF49
DEF rWY   EQU $FF4A
DEF rWX   EQU $FF4B

SECTION "Entry", ROM0[$100]
    nop
    jp Start
    ds $150 - @, 0

SECTION "Main", ROM0[$150]

Start:
    di
    ld sp, $FFFE

.waitVBlank:
    ld a, [rLY]
    cp 144
    jr c, .waitVBlank
    xor a
    ld [rLCDC], a           ; LCD off: VRAM and OAM are free to write

    ld a, %11100100
    ld [rBGP], a
    ld a, %11100100
    ld [rOBP0], a
    ld a, %00011011         ; deliberately not the same mapping as OBP0
    ld [rOBP1], a

    ; Background and window tiles live at $9000, i.e. signed indices 0..11.
    ld hl, $9000
    ld de, BgTiles
    ld bc, BgTilesEnd - BgTiles
    call CopyBytes

    ; Object tiles always use unsigned addressing from $8000.
    ld hl, $8000
    ld de, ObjTiles
    ld bc, ObjTilesEnd - ObjTiles
    call CopyBytes

    ; Background map: tiles 0..7, stepping every cell so no two neighbours match.
    ld hl, $9800
    ld bc, 32 * 32
    ld d, 0
.fillBg:
    ld a, d
    and 7
    ld [hl+], a
    inc d
    dec bc
    ld a, b
    or c
    jr nz, .fillBg

    ; Window map: tiles 8..11, a visibly different set.
    ld hl, $9C00
    ld bc, 32 * 32
    ld d, 0
.fillWindow:
    ld a, d
    and 3
    add a, 8
    ld [hl+], a
    inc d
    dec bc
    ld a, b
    or c
    jr nz, .fillWindow

    ld hl, $FE00
    ld de, OamData
    ld bc, 160              ; the whole OAM, so unused entries are parked off-screen
    call CopyBytes

    ld a, 3                 ; not a multiple of 8, so cells straddle tile edges
    ld [rSCX], a
    ld a, 5
    ld [rSCY], a
    ld a, 96                ; window covers the lower part of the screen
    ld [rWY], a
    ld a, 7 + 40            ; WX is biased by 7
    ld [rWX], a

    ; LCD on, window map $9C00, window on, signed tiles, BG map $9800,
    ; 8x16 objects, objects on, background on.
    ld a, %11100111
    ld [rLCDC], a

.forever:
    halt
    jr .forever

; hl = destination, de = source, bc = length
CopyBytes:
    ld a, [de]
    ld [hl+], a
    inc de
    dec bc
    ld a, b
    or c
    jr nz, CopyBytes
    ret

SECTION "Data", ROM0

BgTiles:
    ; 0: flat colour 0            1: flat colour 3
    dw `00000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000000
    dw `33333333, `33333333, `33333333, `33333333
    dw `33333333, `33333333, `33333333, `33333333
    ; 2: horizontal bands         3: vertical bands
    dw `00000000, `11111111, `22222222, `33333333
    dw `00000000, `11111111, `22222222, `33333333
    dw `01230123, `01230123, `01230123, `01230123
    dw `01230123, `01230123, `01230123, `01230123
    ; 4: diagonal                 5: frame
    dw `03333333, `30333333, `33033333, `33303333
    dw `33330333, `33333033, `33333303, `33333330
    dw `11111111, `12222221, `12333321, `12300321
    dw `12300321, `12333321, `12222221, `11111111
    ; 6: checker                  7: single corner dot
    dw `01010101, `10101010, `01010101, `10101010
    dw `01010101, `10101010, `01010101, `10101010
    dw `30000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000003
    ; 8..11: window tiles, distinct from every background tile
    dw `22222222, `20000002, `20111102, `20133102
    dw `20133102, `20111102, `20000002, `22222222
    dw `11221122, `11221122, `22112211, `22112211
    dw `11221122, `11221122, `22112211, `22112211
    dw `33333333, `30000003, `30333303, `30300303
    dw `30300303, `30333303, `30000003, `33333333
    dw `01230123, `12301230, `23012301, `30123012
    dw `01230123, `12301230, `23012301, `30123012
BgTilesEnd:

ObjTiles:
    ; Objects are 8x16, so each sprite uses a pair of consecutive tiles.
    ; 0/1: solid block with a hollow centre
    dw `03333330, `31111113, `31222213, `31233213
    dw `31233213, `31222213, `31111113, `03333330
    dw `03333330, `31111113, `31000013, `31000013
    dw `31000013, `31000013, `31111113, `03333330
    ; 2/3: asymmetric, so a flip is unmistakable
    dw `33000000, `33300000, `33330000, `33333000
    dw `33333300, `33333330, `33333333, `33333333
    dw `11111111, `11111110, `11111100, `11111000
    dw `11110000, `11100000, `11000000, `10000000
    ; 4/5: fine vertical stripes
    dw `01010101, `01010101, `01010101, `01010101
    dw `01010101, `01010101, `01010101, `01010101
    dw `20202020, `20202020, `20202020, `20202020
    dw `20202020, `20202020, `20202020, `20202020
    ; 6/7: outline only
    dw `33333333, `30000003, `30000003, `30000003
    dw `30000003, `30000003, `30000003, `30000003
    dw `30000003, `30000003, `30000003, `30000003
    dw `30000003, `30000003, `30000003, `33333333
ObjTilesEnd:

OamData:
    ;    Y,      X,   tile, attributes
    db  16 + 20, 8 + 16,  0, %00000000   ; plain, palette 0
    db  16 + 20, 8 + 40,  2, %00100000   ; X flipped
    db  16 + 20, 8 + 64,  2, %01000000   ; Y flipped
    db  16 + 44, 8 + 16,  4, %00010000   ; palette 1
    db  16 + 44, 8 + 40,  6, %10000000   ; behind non-zero background pixels
    db  16 + 44, 8 + 64,  0, %01100000   ; both flips
    db  16 + 68, 8 + 16,  2, %10010000   ; behind background, palette 1
    db  16 + 68, 8 + 40,  4, %00000000
    ds 160 - (@ - OamData), 0            ; remaining entries stay at Y=0, off screen
OamDataEnd:
