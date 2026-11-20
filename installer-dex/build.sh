#!/bin/sh
# Builds docs/rdvr-installer.dex from src/ (needs a JDK and the Android SDK).
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
JAR="$(ls -d "$SDK"/platforms/android-*/android.jar | sort -V | tail -1)"
D8="$(ls -d "$SDK"/build-tools/*/d8 | sort -V | tail -1)"
JAVAC="${JAVAC:-javac}"
rm -rf build && mkdir -p build/classes build/dex
"$JAVAC" --release 11 -cp "$JAR" -d build/classes src/rdvr/*.java
"$D8" --min-api 30 --release --lib "$JAR" --output build/dex build/classes/rdvr/*.class
cp build/dex/classes.dex ../docs/rdvr-installer.dex
ls -l ../docs/rdvr-installer.dex
