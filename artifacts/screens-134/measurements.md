# #134 evidence — measurements captured from the probe scripts

Captured with Playwright against two scratch servers (never the live deploy):
`before` = a worktree at main `1a75dd0` (port 34992), `after` = the branch head
(port 34991). Probe sources: `probe134.ts` (matrix), `probe134b.ts` (busy
overflow + resting toast geometry), `probe134c.ts` (mid-drag undo guard),
`probe134before.ts` (main's gaps). Raw stdout, verbatim.

## BEFORE — main @ 1a75dd0 (`probe134before.ts`, 390px, SW-free context)

```
BEFORE mode hintNodes=0 hintText=null filterRows=0 toggle="Done"
BEFORE in-flight toggle="Done" aria-busy=null toasts=0
BEFORE settled toasts=0 toastButtons=[]
```

No hint, no save feedback, no confirmation, no Undo: a commit is silent and
final (the issue's "accidental tap silently reorders the live list").

## AFTER — branch head (`probe134.ts`, every width x both themes)

```
360/light MODE hint="Drag to reorder. Changes save as you go." color=rgb(82, 82, 91) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
360/light TOAST text="Order savedUndo×" accent=rgb(22, 163, 74) bottomGap=61 hostBottom=72 undo="Undo" undoColor=rgb(109, 40, 217) undoH=44 closeH=44 undoRatio=7.1 afterMsg=true beforeClose=true
360/dark MODE hint="Drag to reorder. Changes save as you go." color=rgb(179, 174, 192) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
360/dark TOAST text="Order savedUndo×" accent=rgb(63, 217, 127) bottomGap=61 hostBottom=72 undo="Undo" undoColor=rgb(196, 181, 253) undoH=44 closeH=44 undoRatio=9.59 afterMsg=true beforeClose=true
390/light MODE hint="Drag to reorder. Changes save as you go." color=rgb(82, 82, 91) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
390/light TOAST text="Order savedUndo×" accent=rgb(22, 163, 74) bottomGap=2 hostBottom=72 undo="Undo" undoColor=rgb(109, 40, 217) undoH=44 closeH=44 undoRatio=7.1 afterMsg=true beforeClose=true
390/dark MODE hint="Drag to reorder. Changes save as you go." color=rgb(179, 174, 192) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
390/dark TOAST text="Order savedUndo×" accent=rgb(63, 217, 127) bottomGap=61 hostBottom=72 undo="Undo" undoColor=rgb(196, 181, 253) undoH=44 closeH=44 undoRatio=9.59 afterMsg=true beforeClose=true
430/light MODE hint="Drag to reorder. Changes save as you go." color=rgb(82, 82, 91) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
430/light TOAST text="Order savedUndo×" accent=rgb(22, 163, 74) bottomGap=65 hostBottom=72 undo="Undo" undoColor=rgb(109, 40, 217) undoH=44 closeH=44 undoRatio=7.1 afterMsg=true beforeClose=true
430/dark MODE hint="Drag to reorder. Changes save as you go." color=rgb(179, 174, 192) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
430/dark TOAST text="Order savedUndo×" accent=rgb(63, 217, 127) bottomGap=61 hostBottom=72 undo="Undo" undoColor=rgb(196, 181, 253) undoH=44 closeH=44 undoRatio=9.59 afterMsg=true beforeClose=true
768/light MODE hint="Drag to reorder. Changes save as you go." color=rgb(82, 82, 91) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
768/light TOAST text="Order savedUndo×" accent=rgb(22, 163, 74) bottomGap=9 hostBottom=16 undo="Undo" undoColor=rgb(109, 40, 217) undoH=44 closeH=44 undoRatio=7.1 afterMsg=true beforeClose=true
768/dark MODE hint="Drag to reorder. Changes save as you go." color=rgb(179, 174, 192) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
768/dark TOAST text="Order savedUndo×" accent=rgb(63, 217, 127) bottomGap=5 hostBottom=16 undo="Undo" undoColor=rgb(196, 181, 253) undoH=44 closeH=44 undoRatio=9.59 afterMsg=true beforeClose=true
1280/light MODE hint="Drag to reorder. Changes save as you go." color=rgb(82, 82, 91) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
1280/light TOAST text="Order savedUndo×" accent=rgb(22, 163, 74) bottomGap=0 hostBottom=16 undo="Undo" undoColor=rgb(109, 40, 217) undoH=44 closeH=44 undoRatio=7.1 afterMsg=true beforeClose=true
1280/dark MODE hint="Drag to reorder. Changes save as you go." color=rgb(179, 174, 192) size=14px filterRows=0 handles=6 overflow=false toggle="Done" busy=null
1280/dark TOAST text="Order savedUndo×" accent=rgb(63, 217, 127) bottomGap=5 hostBottom=16 undo="Undo" undoColor=rgb(196, 181, 253) undoH=44 closeH=44 undoRatio=9.59 afterMsg=true beforeClose=true
390/light BUSY label="Saving…" aria-busy=true disabled=false width=83 doneWidth=59
390/light DANGER text="Couldn't save the new order.×" accent=rgb(220, 38, 38) action=null orderLen=6
390/dark BUSY label="Saving…" aria-busy=true disabled=false width=83 doneWidth=59
390/dark DANGER text="Couldn't save the new order.×" accent=rgb(248, 113, 113) action=null orderLen=6
1280/light BUSY label="Saving…" aria-busy=true disabled=false width=83 doneWidth=59
1280/dark BUSY label="Saving…" aria-busy=true disabled=false width=83 doneWidth=59
```

Note: the TOAST `bottomGap` column was measured mid entry-animation (the toast
slides up). The resting geometry is in the next block.

## AFTER — busy-state overflow + resting toast geometry (`probe134b.ts`)

```
360/light BUSY overflow=false 360/360 offenders=[]
360/light REST toastBottomGap=72 hostBottomGap=72 barHeight=null toasts=1 toast=[16..344] w=328 vw=360 overflow=false offenders=[]
360/dark BUSY overflow=false 360/360 offenders=[]
360/dark REST toastBottomGap=72 hostBottomGap=72 barHeight=null toasts=1 toast=[16..344] w=328 vw=360 overflow=false offenders=[]
390/light BUSY overflow=false 390/390 offenders=[]
390/light REST toastBottomGap=72 hostBottomGap=72 barHeight=null toasts=1 toast=[16..374] w=358 vw=390 overflow=false offenders=[]
390/dark BUSY overflow=false 390/390 offenders=[]
390/dark REST toastBottomGap=72 hostBottomGap=72 barHeight=null toasts=1 toast=[16..374] w=358 vw=390 overflow=false offenders=[]
430/light BUSY overflow=false 430/430 offenders=[]
430/light REST toastBottomGap=72 hostBottomGap=72 barHeight=null toasts=1 toast=[16..414] w=398 vw=430 overflow=false offenders=[]
430/dark BUSY overflow=false 430/430 offenders=[]
430/dark REST toastBottomGap=72 hostBottomGap=72 barHeight=null toasts=1 toast=[16..414] w=398 vw=430 overflow=false offenders=[]
```

`toasts=1` at every width: the keyed snackbar replaces, never stacks.

## AFTER — mid-drag Undo guard, AC6a (`probe134c.ts`)

```
first commit PUTs=1 undoVisible=true
mid-drag undo tap: PUTsBefore=1 PUTsAfter=1 ignored=true
after drop: PUTs=2 finalIsDragResult=true
```

An Undo tapped while a drag is live issues **no** order PUT and reverts
nothing; the drop's own commit is the only write.

## What the before/after delta is, in one table

| Signal | main @ 1a75dd0 | this branch |
|---|---|---|
| reorder-mode hint nodes | 0 | 1 (`"Drag to reorder. Changes save as you go."`, `--text-2`, 14px) |
| save feedback while a commit PUT is in flight | none (toggle stays "Done") | `"Saving…"` + `aria-busy="true"`, still enabled (83px vs 59px, no overflow) |
| confirmation after a commit | none | one `.toast` "Order saved" with an Undo action |
| undo affordance | none | `Undo` button, 44px high, contrast 7.1:1 light / 9.59:1 dark |
| snackbar stacking | n/a | keyed replace — exactly 1 `.toast` after two commits |
| stale/failed undo | n/a | 400 → danger toast, order left at the committed order |
| mid-drag undo tap | n/a | ignored (0 PUTs) |
