"""Developer-facing CLI for offline transcription tasks."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from backend.transcription_service import TranscriptionError, transcribe_audio_file


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sing-attune")
    subparsers = parser.add_subparsers(dest="command", required=True)

    transcribe = subparsers.add_parser("transcribe", help="Transcribe a WAV file into MusicXML")
    transcribe.add_argument("input", help="Path to input WAV file")
    transcribe.add_argument(
        "-o",
        "--output",
        help="Output MusicXML path. Defaults to the input path with a .musicxml suffix.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "transcribe":
        input_path = Path(args.input)
        output_path = Path(args.output) if args.output else input_path.with_suffix(".musicxml")
        try:
            result = transcribe_audio_file(input_path)
        except (FileNotFoundError, TranscriptionError) as exc:
            print(str(exc), file=sys.stderr)
            return 1

        output_path.write_text(result.musicxml, encoding="utf-8")
        print(output_path)
        return 0

    parser.error(f"Unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
