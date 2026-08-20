# Mobile

iOS and Android build from the same codebase as the desktop application, through Tauri 2. The
drawing engine, the domain crates, the project store and the interface are identical; what differs
is packaging, file access and the layout.

> **Status: builds configured, not yet published.** The mobile targets compile, and nobody has run
> a real review on a tablet yet. See [status.md](status.md). Publishing to TestFlight and a Play
> internal track is 0.4 on the [roadmap](roadmap.md).

## Building

Needs the desktop prerequisites plus the platform SDK.

### Android

```bash
# Android Studio, the NDK, and:
export ANDROID_HOME=$HOME/Android/Sdk
export NDK_HOME=$ANDROID_HOME/ndk/<version>

npm run tauri android init     # once
npm run tauri android dev      # on a device or emulator
npm run tauri android build    # AAB and APK
```

### iOS

macOS with Xcode, and an Apple Developer account to run on hardware.

```bash
npm run tauri ios init         # once
npm run tauri ios dev
npm run tauri ios build
```

## What is different on a phone or tablet

**File access.** There are no folder paths. A project comes from the system document provider —
Files, SharePoint, Drive, whatever the user has — and the application never handles a path, which
happens to be the same rule the desktop build follows for its own reasons.

**Layout.** Below 720px the sheet index becomes a strip above the drawing rather than taking a
third of the width from it, and safe-area insets are respected so the notch and the home indicator
do not sit over the interface.

**Touch and pen.** The drawing engine owns this and is the reason mobile is viable at all: pinch to
zoom, two fingers to reposition mid-markup, one finger to draw when a tool is armed and to scroll
when one is not. Gesture ownership is switched explicitly rather than left to `touch-action`
defaults, and a gesture the browser claims mid-way arrives as `pointercancel` with no `pointerup`,
which is handled rather than leaving the viewer mid-drag.

A stylus suppresses touch for a short window afterwards, so a hand resting on a tablet neither
draws nor starts a pinch under the pen. Pressure samples are recorded even though the renderer
draws one width — discarding them at capture time would make variable-width rendering unrecoverable
later.

**Rasterisation limits.** Mobile canvas limits are lower than desktop, which is why the engine
tiles the visible region rather than rendering a page to one canvas. A D-size sheet at high zoom
would otherwise silently produce a blank page at exactly the moment somebody zooms in to read a
dimension.

**Updates** come from the app stores, not from the updater. The updater capability is desktop-only,
declared as such in `capabilities/updates.json`.

**Memory.** The bound on concurrent render jobs matters far more here than on a workstation. It is
the same `ResourceLimits` value and can be tightened per platform.

## What is not done

- Not run on real hardware by a human.
- No store listings, no signing identities, no distribution.
- The project chrome is responsive but not touch-*first* — targets are desktop-sized and the
  toolbar wants rethinking for a thumb.
- No offline import from a document provider that streams rather than hands over a file.
