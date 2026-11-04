# Helicopter texture A/B for PR #94 (RAY-105). Do not merge this branch.

This renders the near helicopter model on its own at 1600x900 from 4 views (wide, close, side, gun). "old" is main at 290a32b (kong-air.glb, 4096² maps), and "new" is this branch's, with 2048² maps.

```
git fetch origin
git checkout mem/heli-ab-harness
npm ci
node tools/heli-ab/shot.mjs . d3d11 heli-ab-out      # or: metal on a Mac
```

The script prints the GPU string and writes `heli-ab-out/<view>-old.png` and `<view>-new.png`. The check passes when the close and gun pairs show no visible loss of paint or decal detail.
