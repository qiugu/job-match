import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts/configure-apt.sh"


@pytest.mark.parametrize("format", ["sources", "list"])
def test_mirrors_preserve_suites_signatures_and_download_cache(tmp_path, format):
    (tmp_path / "sources.list.d").mkdir()
    (tmp_path / "apt.conf.d").mkdir()
    cleaner = tmp_path / "apt.conf.d/docker-clean"
    cleaner.write_text('DPkg::Post-Invoke { "rm -f /var/cache/apt/archives/*.deb"; };')
    source = tmp_path / "sources.list.d" / f"debian.{format}"
    if format == "sources":
        source.write_text(
            "Types: deb\nURIs: http://deb.debian.org/debian\n"
            "Suites: trixie trixie-updates\nComponents: main\n"
            "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\n"
            "Types: deb\nURIs: http://deb.debian.org/debian-security\n"
            "Suites: trixie-security\nComponents: main\n"
            "Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg\n"
        )
    else:
        source.write_text(
            "deb http://deb.debian.org/debian trixie main\n"
            "deb http://security.debian.org/debian-security trixie-security main\n"
        )
    original = source.read_text()
    for _ in range(2):  # Repeat configuration safely.
        subprocess.run(
            ["sh", str(SCRIPT), "https://mirror.example/debian",
             "https://mirror.example/debian-security", str(tmp_path)],
            check=True,
        )
    expected = original.replace("http://deb.debian.org/debian-security", "https://mirror.example/debian-security")
    expected = expected.replace("http://security.debian.org/debian-security", "https://mirror.example/debian-security")
    expected = expected.replace("http://deb.debian.org/debian", "https://mirror.example/debian")
    assert source.read_text() == expected
    assert not cleaner.exists()
    config = (tmp_path / "apt.conf.d/keep-cache").read_text()
    assert 'Keep-Downloaded-Packages "true"' in config


def test_invalid_mirror_does_not_modify_apt_configuration(tmp_path):
    result = subprocess.run(
        ["sh", str(SCRIPT), "https://bad.example/;exit 0", "https://mirror.example/security", str(tmp_path)],
        capture_output=True,
    )
    assert result.returncode != 0
    assert list(tmp_path.iterdir()) == []
