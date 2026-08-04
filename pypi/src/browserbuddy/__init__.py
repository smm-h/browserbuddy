"""Name reservation for BrowserBuddy on PyPI.

The real BrowserBuddy MCP server is a Node package published to npm. This
distribution exists only to hold the name; every entry point is a hard error
so nothing can mistake it for a working implementation.
"""

import sys

__version__ = "0.2.0"

_MESSAGE = (
    "BrowserBuddy's PyPI package is a name reservation. The MCP server ships "
    "on npm: npx browserbuddy serve — see https://github.com/smm-h/browserbuddy"
)


def main() -> int:
    """Print the reservation notice to stderr and fail."""
    print(_MESSAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
