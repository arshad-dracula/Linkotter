#!/usr/bin/env python3
"""Turns a checkout of the open-source Android client into the Linkotter app.

    rebrand.py <checkout-dir> [default-control-url]

Every edit asserts that the text it expects is present, so an upstream change that
moves something fails the build loudly instead of silently shipping a half-branded app.
"""
import pathlib
import re
import sys

APP_ID = "ai.propvr.linkotter"
APP_NAME = "Linkotter"
# PropVR design tokens
BLUE, BLUE_DEEP, INDIGO, TINT = "0D54FE", "0A3DBB", "6C68FD", "EEF3FF"

root = pathlib.Path(sys.argv[1])
control_url = sys.argv[2] if len(sys.argv) > 2 else ""
if control_url and not re.fullmatch(r"https://[A-Za-z0-9.-]+(:\d+)?", control_url):
    sys.exit(f"control URL must look like https://host[:port], got {control_url!r}")


def edit(rel, old, new, count=1, regex=False):
    p = root / rel
    s = p.read_text()
    n = len(re.findall(old, s)) if regex else s.count(old)
    if n < 1 or (count and n != count):
        sys.exit(f"{rel}: expected {count or 'at least 1'} match(es) of {old!r}, found {n}")
    p.write_text(re.sub(old, new, s) if regex else s.replace(old, new))


# 1. Own application ID so it installs next to other VPN apps, plus the built-in server address.
edit("android/build.gradle.kts", "    minSdk = 26\n",
     f'    minSdk = 26\n    applicationId = "{APP_ID}"\n'
     f'    buildConfigField("String", "LINKOTTER_CONTROL_URL", "\\"{control_url}\\"")\n')

# 2. Name.
edit("android/src/main/AndroidManifest.xml", 'android:label="Tailscale"', f'android:label="{APP_NAME}"')
strings = "android/src/main/res/values/strings.xml"
edit(strings, "Tailscale", APP_NAME, count=0)
# Keep the legally required attribution accurate after the rename.
edit(strings, r'(<string name="about_view_footnotes">)[^<]*(</string>)',
     r"\1WireGuard is a registered trademark of Jason A. Donenfeld.\\n\\n"
     r"Linkotter is built on open-source software by Tailscale Inc. and contributors, "
     r"used under the BSD 3-Clause licence. Tailscale is a registered trademark of Tailscale Inc.\2",
     regex=True)

# 3. Sign in against our control server unless the user typed another one.
vm = "android/src/main/java/com/tailscale/ipn/ui/viewModel/IpnViewModel.kt"
edit(vm, "    val finalMaskedPrefs = maskedPrefs?.deepCopy() ?: Ipn.MaskedPrefs()\n",
     "    val finalMaskedPrefs = maskedPrefs?.deepCopy() ?: Ipn.MaskedPrefs()\n"
     "    if (finalMaskedPrefs.ControlURL == null &&\n"
     "        com.tailscale.ipn.BuildConfig.LINKOTTER_CONTROL_URL.isNotEmpty()) {\n"
     "      finalMaskedPrefs.ControlURL = com.tailscale.ipn.BuildConfig.LINKOTTER_CONTROL_URL\n"
     "    }\n")

# 4. PropVR colours.
theme = "android/src/main/java/com/tailscale/ipn/ui/theme/Theme.kt"
for old, new in (("4B70CC", BLUE), ("3E5DB3", BLUE_DEEP), ("5A82DC", INDIGO)):
    edit(theme, f"(?i)0xFF{old}", f"0xFF{new}", count=0, regex=True)
edit(theme, "(?i)0xFFF0F5FF", f"0xFF{TINT}", count=0, regex=True)
edit("android/src/main/java/com/tailscale/ipn/ui/theme/Color.kt", "0xFF4B70CC", f"0xFF{BLUE}", count=0)
edit("android/src/main/res/values/ic_launcher_background.xml", "#1F1E1E", f"#{BLUE}")


# 5. Icons: two joined links, drawn on a 108-unit grid (launcher safe zone is the middle 66).
def mark(size_dp, scale, colour):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="{size_dp}dp" android:height="{size_dp}dp"
    android:viewportWidth="108" android:viewportHeight="108">
  <group android:pivotX="54" android:pivotY="54" android:rotation="-45"
      android:scaleX="{scale}" android:scaleY="{scale}">
    <path android:strokeColor="{colour}" android:strokeWidth="6" android:fillColor="#00000000"
        android:pathData="M40,44h10a10,10 0,0 1,0 20h-10a10,10 0,0 1,0 -20z"/>
    <path android:strokeColor="{colour}" android:strokeWidth="6" android:fillColor="#00000000"
        android:pathData="M58,44h10a10,10 0,0 1,0 20h-10a10,10 0,0 1,0 -20z"/>
  </group>
</vector>
'''


res = root / "android/src/main/res/drawable"
for name, size, scale, colour in (
    ("ic_launcher_foreground.xml", 108, 1.0, "#FFFFFF"),
    ("ic_notification.xml", 24, 2.0, "#000000"),
    ("ic_notification_disabled.xml", 24, 2.0, "#66000000"),
    ("ic_tile.xml", 24, 2.0, "#FFFFFF"),
):
    if not (res / name).exists():
        sys.exit(f"drawable {name} no longer exists upstream")
    (res / name).write_text(mark(size, scale, colour))

# 6. Never upload engine logs to the upstream vendor, whatever the in-app toggle says.
edit("libtailscale/backend.go",
     "func start(dataDir, directFileRoot string, hwAttestationPref bool, appCtx AppContext) Application {\n",
     "func start(dataDir, directFileRoot string, hwAttestationPref bool, appCtx AppContext) Application {\n"
     '\tos.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")\n')
edit("libtailscale/tailscale.go", "Disabled: !enableUpload,", "Disabled: true,")

# 7. Build only the app; upstream's unit tests assert on upstream strings.
edit("Makefile", "./gradlew test assembleDebug", "./gradlew assembleDebug")

print(f"Rebranded {root} as {APP_NAME} ({APP_ID}); default server: {control_url or 'none (entered in the app)'}")
