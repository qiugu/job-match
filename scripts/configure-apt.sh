#!/bin/sh
# Configure Debian container sources without changing suites or signature checks.
# Usage: configure-apt.sh ARCHIVE_URL SECURITY_URL [APT_CONFIG_DIRECTORY]
set -eu
archive="${1:?Debian archive URL required}"
security="${2:?Debian security URL required}"
apt_dir="${3:-/etc/apt}"

for url in "$archive" "$security"; do
    case "$url" in
        https://?*) ;;
        *) echo "APT mirror must use HTTPS" >&2; exit 1 ;;
    esac
    case "$url" in
        *[!a-zA-Z0-9:/._-]*) echo "Invalid APT mirror URL" >&2; exit 1 ;;
    esac
done

for source in "$apt_dir/sources.list" "$apt_dir"/sources.list.d/*.list "$apt_dir"/sources.list.d/*.sources; do
    [ -f "$source" ] || continue
    # Replace security first because the archive URL is its prefix.
    sed -E \
        -e "s|https?://(deb\|security)\.debian\.org/debian-security/?([[:space:]]\|$)|${security%/}\2|g" \
        -e "s|https?://deb\.debian\.org/debian/?([[:space:]]\|$)|${archive%/}\1|g" \
        "$source" > "$source.tmp"
    mv "$source.tmp" "$source"
done

# The official slim image otherwise deletes .deb files after installation,
# defeating the BuildKit /var/cache/apt mount.
rm -f "$apt_dir/apt.conf.d/docker-clean"
printf '%s\n' 'Binary::apt::APT::Keep-Downloaded-Packages "true";' \
    > "$apt_dir/apt.conf.d/keep-cache"
