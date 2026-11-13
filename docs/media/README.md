Images for the README: screenshots and short looping previews of the videos.

Videos live on YouTube, which GitHub can't embed or autoplay. Each one gets an animated
WebP here that loops in the README and links to the video:

| File | Video |
|---|---|
| `hopper-demo.webp` | https://youtu.be/inJyThbF6EE (demo, previewed at 2x) |
| `hopper-install.webp` | https://youtu.be/_CVanOha9q8 (install, 2x) |
| `hopper-uninstall.webp` | https://youtu.be/6xyuDwNRh9w (uninstall --purge, 2x) |

Made from the redacted recordings with ffmpeg, for example:

    ffmpeg -i in.mp4 -vf "fps=12,scale=1280:-2:flags=lanczos" -an -c:v libwebp_anim       -loop 0 -q:v 80 -compression_level 6 -map_metadata -1 out.webp

Before adding one, look at every frame for hostnames, IP addresses (an SSH login's
"Last login ... from" line), emails, account names and browser suggestions.
