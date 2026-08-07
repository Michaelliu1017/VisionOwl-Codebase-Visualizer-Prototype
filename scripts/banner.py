#!/usr/bin/env python3
"""Render the VisionOwl development banner with pybanner."""

from pybanner import banner_clr6x6 as banner


def main() -> None:
    banner.print("VISIONOWL", spacing=1)


if __name__ == "__main__":
    main()
