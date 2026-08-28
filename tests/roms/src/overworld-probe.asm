; overworld-probe — a miniature overworld for the depth renderer.
;
; The height model has no per-game knowledge; it works out which tiles are
; ground by watching where characters can be. To test that, this ROM builds the
; situation it is meant to read: a scrolling map of ground tiles with scenery
; scattered through it, and a character walking a corridor that only ever
; crosses ground.
;
; Correct behaviour is that the scenery tile rises and the ground tiles stay
; flat — with nothing anywhere in the ROM saying which is which.

DEF rLCDC EQU $FF40
DEF rSCY  EQU $FF42
DEF rSCX  EQU $FF43
DEF rLY   EQU $FF44
DEF rBGP  EQU $FF47
DEF rOBP0 EQU $FF48
DEF rOBP1 EQU $FF49

; The character's feet sit in this map row, so this row must be all ground.
DEF WALK_ROW EQU 9
DEF TILE_SCENERY EQU 4

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
    ld [rLCDC], a

    ld a, %11100100
    ld [rBGP], a
    ld [rOBP0], a
    ld a, %11100100
    ld [rOBP1], a

    ld hl, $8000            ; unsigned tile addressing for both layers
    ld de, Tiles
    ld bc, TilesEnd - Tiles
    call CopyBytes

    ; Build the map: ground everywhere, scenery on a scattered pattern, and a
    ; clear corridor along the row the character walks.
    ld hl, $9800
    ld b, 0                 ; y
.rowLoop:
    ld c, 0                 ; x
.colLoop:
    ld a, b
    cp WALK_ROW
    jr z, .ground           ; the corridor is never blocked

    ld a, b
    add a, b
    add a, b                ; y * 3
    add a, c                ; + x
    and 3
    jr nz, .ground
    ld a, TILE_SCENERY
    jr .store

.ground:
    ld a, c
    and 1                   ; alternate the two ground tiles

.store:
    ld [hl+], a
    inc c
    ld a, c
    cp 32
    jr nz, .colLoop
    inc b
    ld a, b
    cp 32
    jr nz, .rowLoop

    ld hl, $FE00
    ld de, OamData
    ld bc, 160
    call CopyBytes

    xor a
    ld [rSCX], a
    ld [rSCY], a

    ; LCD on, BG map $9800, unsigned tile data at $8000 (bit 4), 8x16 objects,
    ; objects and BG on.
    ld a, %10010111
    ld [rLCDC], a

; Scroll steadily so the map is visibly a world being walked through.
Loop:
.wait:
    ld a, [rLY]
    cp 144
    jr nz, .wait

    ld a, [rSCX]
    inc a
    ld [rSCX], a

.drain:
    ld a, [rLY]
    cp 144
    jr z, .drain
    jr Loop

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

Tiles:
    ; 0: ground, fine speckle
    dw `00000000, `00100000, `00000000, `00001000
    dw `00000000, `10000000, `00000000, `00000100
    ; 1: ground variant
    dw `00000000, `00000100, `00000000, `00100000
    dw `00000000, `00010000, `00000000, `00000010
    ; 2: unused ground variant
    dw `00000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000000
    ; 3: unused
    dw `11111111, `11111111, `11111111, `11111111
    dw `11111111, `11111111, `11111111, `11111111
    ; 4: scenery — dense and unmistakable
    dw `33333333, `32222223, `32333323, `32311323
    dw `32311323, `32333323, `32222223, `33333333
    ; 5..7: spare, kept blank
    dw `00000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000000
    dw `00000000, `00000000, `00000000, `00000000
    ; 8/9: the character, an 8x16 figure
    dw `00333300, `03222230, `32133123, `32333323
    dw `32311323, `32333323, `03222230, `00333300
    dw `00322300, `00322300, `03322330, `03300330
    dw `03300330, `03300330, `03000030, `03000030
TilesEnd:

OamData:
    ;   Y,       X,       tile, attributes
    db  16 + 64, 8 + 76,  8, %00000000    ; feet land in map row WALK_ROW
    ds 160 - (@ - OamData), 0
OamDataEnd:
