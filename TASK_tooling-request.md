# TASK: Tooling request — programs I would have liked to have

Created at the end of the manga-catalogue session (context: cataloguing/unzipping the
hentai-manga collection in this Downloads folder, inside the `pi-sandbox` podman container).

The work itself is DONE (see `MANGA_REPORT.md`), but the following missing tools cost real
time and forced workarounds. If this environment is rebuilt, install these:

## High value (directly blocked work)
1. **`unrar`** (or **`7z`/p7zip**) — RAR extraction. The container had no unzip/7z/unrar at
   all. Workaround: downloaded the RARLAB `rarlinux-x64` static tarball to /tmp and used
   `./rar/unrar`. A system-wide `unrar` (or `7zz` with RAR support) would make any archive
   trivial to open.
2. **`unzip`** — for the many .zip files. Workaround: `python3 -m zipfile` / `zipfile` module
   in a script. Fine, but clunky for hundreds of files.
3. **A C compiler (`gcc`/`cc`)** — `pip install unrar-cffi` (the no-binary-needed RAR decoder)
   failed with `FileNotFoundError: 'cc'`. With gcc this would have been the cleanest RAR fix.
   Bonus: would also let pip build other sdist packages.
4. **`pip install wheel` working / modern setuptools** — `wheel` was reported "not available"
   even inside the venv, compounding the build failure.

## Medium value (would have made cataloguing faster)
5. **`xxd` or `hexdump`** — checking archive magic bytes (RAR4 vs RAR5 vs zip) was done with
   `od` because xxd is absent.
6. **ImageMagick (`identify`/`convert`) or Python Pillow** — verifying page counts, detecting
   duplicate images by hash/perceptual hash (the two Giselle-chan releases, `1272728309117.jpg`
   + `(2)` duplicate), and generating thumbnails/covers for a visual catalogue. (Only raw
   `read` of images is possible now.)
7. **`sha256sum`/`md5sum`** — for the duplicate-detection above (md5sum/sha256sum are present
   in most images; confirm here).

## Nice to have
8. **`fd` / better find aliases** — some aliasing existed, but a real `fd` + `rg` (rg present)
   combo speeds up tree work.
9. **`tree`** — for readable directory overviews in reports.
10. **`7z` with 7z/ISO support** — the folder contains many formats; one universal extractor
    (7z handles zip/rar*/7z/tar/gz/iso) would cover 95% of future cases.

## Not needed
- `apt`/root: not required once the above are in the image.
- Network to RARLAB worked, so downloading tools ad hoc is a viable fallback.

### Acceptance
A rebuilt image where `unzip foo.zip`, `unrar x foo.rar` and `gcc --version` all succeed,
plus `xxd`, `identify`, `tree`, `fd` on PATH.
