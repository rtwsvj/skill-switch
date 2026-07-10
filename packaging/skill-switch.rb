# PLANNED / NOT INSTALLABLE
#
# This file is deliberately not a Homebrew Formula.  The repository does not
# currently publish a Homebrew tap or a standalone, checksummed CLI archive.
# Keeping a Formula with placeholder hashes (or downloading a DMG while
# installing a different npm package) would make the installation path
# misleading and non-reproducible.
#
# Activate this channel only after all of the following are true:
#   1. a maintained rtwsvj/homebrew-tap repository exists;
#   2. the release publishes a versioned macOS artifact for each supported CPU;
#   3. every artifact has a real SHA-256 checksum;
#   4. the Formula/Cask installs exactly the artifact named by its URL; and
#   5. clean-machine install, upgrade, uninstall, version, and audit smoke tests pass.
#
# Until then, use the npm/npx CLI path documented in docs/distribution.md, or
# build the unsigned macOS app from source.  Do not copy this stub into a tap.
