"""Package the ordinary example skills without generated files or local caches."""
from pathlib import Path
import argparse
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ('office-presentation', 'table-report')


def main():
    parser = argparse.ArgumentParser(description='生成可上传的普通技能示例ZIP。')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/general-skills-20261117/examples')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for package in PACKAGES:
        source = ROOT / 'examples/skills' / package
        target = args.output / (package + '.zip')
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(source.rglob('*')):
                if not path.is_file() or path.is_symlink() or '__pycache__' in path.parts or path.suffix not in {'.md', '.py', '.txt', '.json', '.csv'}:
                    continue
                info = zipfile.ZipInfo(path.relative_to(source).as_posix(), date_time=(2026, 11, 17, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
        print(target.resolve())


if __name__ == '__main__':
    main()
