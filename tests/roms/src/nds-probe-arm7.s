@ nds-probe, ARM7 side.
@
@ The probe only exercises the display, which the ARM9 owns, so this core just
@ parks itself. It still has to exist: a DS ROM carries binaries for both CPUs.

    .arm
    .section .text
    .global _start

_start:
    b _start
