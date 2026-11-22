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


# 5. Icons: the Linkotter otter, drawn as Android vectors (100-unit face, see desktop/ui/dist/otter.svg).
def circle(cx, cy, r):
    return f"M{cx - r},{cy}a{r},{r} 0 1,0 {2 * r},0a{r},{r} 0 1,0 {-2 * r},0z"


def ellipse(cx, cy, rx, ry):
    return f"M{cx - rx},{cy}a{rx},{ry} 0 1,0 {2 * rx},0a{rx},{ry} 0 1,0 {-2 * rx},0z"


HEAD = ellipse(50, 55, 34, 28)
EARS = circle(19, 45, 7.5) + circle(81, 45, 7.5)
NOSE = "M43,58.6c0,-2.3 3.1,-3.6 7,-3.6s7,1.3 7,3.6c0,2.6 -3.9,5 -7,5s-7,-2.4 -7,-5z"


def fill(d, colour, extra=""):
    return f'<path android:fillColor="{colour}" android:pathData="{d}"{extra}/>'


def stroke(d, colour, width):
    return (f'<path android:strokeColor="{colour}" android:strokeWidth="{width}" android:strokeLineCap="round" '
            f'android:strokeLineJoin="round" android:fillColor="#00000000" android:pathData="{d}"/>')


def vector(size_dp, body, scale, tx, ty):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="{size_dp}dp" android:height="{size_dp}dp"
    android:viewportWidth="108" android:viewportHeight="108">
  <group android:scaleX="{scale}" android:scaleY="{scale}" android:translateX="{tx}" android:translateY="{ty}">
    {body}
  </group>
</vector>
'''


FACE = "\n    ".join([
    fill(EARS, "#8B5E3C"), fill(circle(19, 45, 3.6) + circle(81, 45, 3.6), "#5E3E27"),
    fill(HEAD, "#8B5E3C"),
    f'<group><clip-path android:pathData="{HEAD}"/>{fill(ellipse(50, 74, 30, 15), "#EBCFAE")}</group>',
    fill(circle(42.5, 66, 9.5) + circle(57.5, 66, 9.5), "#F8E6CF"),
    stroke("M34,63L13,58M34,67L12,68M66,63L87,58M66,67L88,68", "#F8E6CF", 1.6),
    fill(circle(37, 50, 3.8) + circle(63, 50, 3.8), "#151521"),
    fill(circle(38.2, 48.8, 1.2) + circle(64.2, 48.8, 1.2), "#FFFFFF"),
    fill(NOSE, "#151521"),
    stroke("M50,63.5v2M45.6,67.2c1.6,1.6 3.2,1.4 4.4,-0.5 1.2,1.9 2.8,2.1 4.4,0.5", "#151521", 1.7),
])


def silhouette(colour):
    # One colour: head and ears, with the eyes and nose cut out.
    return "\n    ".join([
        fill(EARS, colour),
        fill(HEAD + circle(37, 50, 4.4) + circle(63, 50, 4.4) + NOSE, colour, ' android:fillType="evenOdd"'),
        stroke("M20,60L8,57M20,66L7,68M80,60L92,57M80,66L93,68", colour, 2.6),
    ])


res = root / "android/src/main/res/drawable"
icons = {
    "ic_launcher_foreground.xml": vector(108, FACE, 0.84, 12, 3.6),
    "ic_notification.xml": vector(24, silhouette("#000000"), 1.2, -6, -18),
    "ic_notification_disabled.xml": vector(24, silhouette("#66000000"), 1.2, -6, -18),
    "ic_tile.xml": vector(24, silhouette("#FFFFFF"), 1.2, -6, -18),
}
for name, xml in icons.items():
    if not (res / name).exists():
        sys.exit(f"drawable {name} no longer exists upstream")
    (res / name).write_text(xml)
# Themed (monochrome) launcher icon gets the silhouette, so the face still reads in one colour.
(res / "ic_launcher_monochrome.xml").write_text(vector(108, silhouette("#000000"), 0.84, 12, 3.6))
for adaptive in ("ic_launcher.xml", "ic_launcher_round.xml"):
    edit(f"android/src/main/res/mipmap-anydpi-v26/{adaptive}",
         '<monochrome android:drawable="@drawable/ic_launcher_foreground" />',
         '<monochrome android:drawable="@drawable/ic_launcher_monochrome" />')

# 6. Never upload engine logs to the upstream vendor, whatever the in-app toggle says.
edit("libtailscale/backend.go",
     "func start(dataDir, directFileRoot string, hwAttestationPref bool, appCtx AppContext) Application {\n",
     "func start(dataDir, directFileRoot string, hwAttestationPref bool, appCtx AppContext) Application {\n"
     '\tos.Setenv("TS_NO_LOGS_NO_SUPPORT", "true")\n')
edit("libtailscale/tailscale.go", "Disabled: !enableUpload,", "Disabled: true,")

# 7. Build only the app; upstream's unit tests assert on upstream strings.
edit("Makefile", "./gradlew test assembleDebug", "./gradlew assembleDebug")

print(f"Rebranded {root} as {APP_NAME} ({APP_ID}); default server: {control_url or 'none (entered in the app)'}")
