#!/usr/bin/env python3
"""Package source bytes only. Runs no application code, tests or build scripts."""
import gzip
import hashlib
import io
import json
import stat
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
PREFIX = f'lattis-{VERSION}-source'
OUTPUT = ROOT / 'release-bundles'
SOURCES = [
    'LICENSE', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'PRODUCT_POLICY.md',
    'AGENTS.md', 'LATTIS_PROMPT_STARTOWY.md', '.gitignore', '.env.example',
    'package.json', 'package-lock.json', 'tsconfig.json', 'lattis.config.json', 'lattis.lock',
    'bin', 'src', 'db', 'packages/local', 'runner', 'wordpress', 'web',
    'openapi', 'tools', 'updater', 'deployment', 'docs', 'examples',
]
OMIT_DIRECTORIES = {'node_modules', '.git', '.lattis', '__pycache__', 'dist', 'release-bundles', 'offline-keys'}
ALLOWED_DOTFILES = {'.gitignore', '.env.example'}
PRIVATE_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.log', '.pyc'}


def members(path):
    if path.is_symlink():
        raise RuntimeError('Source packaging does not follow symlinks')
    if path.name in OMIT_DIRECTORIES or (path.name.startswith('.') and path.name not in ALLOWED_DOTFILES):
        return
    if path.is_dir():
        for child in sorted(path.iterdir()):
            yield from members(child)
    elif path.is_file() and path.suffix.lower() not in PRIVATE_SUFFIXES:
        yield path


def put(archive, name, content, mode=0o644):
    item = tarfile.TarInfo(f'{PREFIX}/{name}')
    item.size = len(content)
    item.mode = mode
    item.mtime = 0
    item.uid = item.gid = 0
    item.uname = item.gname = ''
    archive.addfile(item, io.BytesIO(content))


OUTPUT.mkdir(exist_ok=True)
archive_path = OUTPUT / f'{PREFIX}.tar.gz'
metadata = {
    'schemaVersion': 1,
    'artifactType': 'source-archive',
    'version': VERSION,
    'preparedOn': '2026-10-07',
    'license': 'MIT',
    'copyrightHolder': '#1 GROUP PROSTA SPÓŁKA AKCYJNA',
    'status': 'alpha-source-prepared-unverified',
    'verification': 'not-run-by-user-instruction',
    'qualityReview': 'pending',
    'signed': False,
    'published': False,
    'productionReadiness': 'not-established',
    'dependencyInstallationsIncluded': False,
    'runtimeDescriptorVersion': 3,
    'geodeCatalogVersion': 3,
    'minimumUpdaterMajor': 2,
    'knownPathExclusions': sorted(OMIT_DIRECTORIES | {'.env', '.npmrc', '*.pem', '*.key', '*.p12', '*.pfx', '*.log'}),
    'note': 'Packaging and SHA-256 identify source bytes; neither is a security review or runtime authorization.',
    'files': {},
}
with archive_path.open('xb') as destination:
    with gzip.GzipFile(filename='', mode='wb', fileobj=destination, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for source in SOURCES:
                for path in members(ROOT / source):
                    name = path.relative_to(ROOT).as_posix()
                    content = path.read_bytes()
                    metadata['files'][name] = {'digest': 'sha256:' + hashlib.sha256(content).hexdigest(), 'length': len(content)}
                    put(archive, name, content, 0o755 if path.stat().st_mode & stat.S_IXUSR else 0o644)
            put(archive, 'SOURCE_RELEASE.json', (json.dumps(metadata, ensure_ascii=False, indent=2) + '\n').encode())

checksum = hashlib.sha256(archive_path.read_bytes()).hexdigest()
metadata['archive'] = {'file': archive_path.name, 'digest': 'sha256:' + checksum, 'length': archive_path.stat().st_size}
with (OUTPUT / f'{PREFIX}.release.json').open('x') as destination:
    destination.write(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
with (OUTPUT / f'{PREFIX}.sha256').open('x') as destination:
    destination.write(f'{checksum}  {archive_path.name}\n')
print(json.dumps({'archive': str(archive_path), 'metadata': str(OUTPUT / f'{PREFIX}.release.json'), 'status': metadata['status']}))
