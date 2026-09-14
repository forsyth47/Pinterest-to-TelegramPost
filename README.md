# Pinterest-to-TelegramPost

Userscript to open original Pinterest images and post them to Telegram from keyboard shortcuts.
> ⚠️ The script requires configuration to post to telegram (read below)

## How it works
- Hover an image on Pinterest and press `z` to open its original image URL in a new tab.
- Hover an image and press `x` to open a popup, add an optional caption, and send it to your Telegram channel.
- The script resolves the original image URL from Pinterest page data and sends it through the Telegram Bot API.

## Installation 
Copy the contents of script.user.js from [github.com/forsyth/pinterest-to-telegrampost](https://github.com/forsyth47/Pinterest-to-TelegramPost/blob/main/script.user.js)

  - OR

![Greasy Fork Downloads](https://img.shields.io/greasyfork/dd/595792-pinterest-post-to-telegram?style=flat-square&label=Install%20via%20Greasyfork.&link=https%3A%2F%2Fgreasyfork.org%2Fen%2Fscripts%2F595792-pinterest-post-to-telegram)


## Configuration
Edit `script.user.js`:

(Necessary)
- `TG_BOT_TOKEN`: your Telegram bot token.
- `TG_CHANNEL_ID`: target channel ID (usually with `-100` prefix).

(Optional)
- `KEY_TO_OPEN`, `KEY_TO_POST`: keyboard shortcuts.
- `ACTIVATE_NEW_TAB` (true/false): whether opened image tabs are focused.
- `CAPTION_WITH_SOURCE_URL` (true/false): prefill caption with the pin URL.
- `THEME`: 1=green phosphor(matrix), 2=amber, 3=ice-blue
- `SCANLINES` (true/false): popup visual style.


## Requirements
- Must be logged in (original image URL doesn't seem to exist in the code when logged out).
- Tampermonkey or Violentmonkey on a recent version of Firefox or Chrome.

## Known issues
- Story pins (multiple images per pin) only opens the first image.
- Doesn't work on "Visually similar results".
- If you're not hovering over an image and press `z`, it will open the very first image in the pin grid.

## Credits
Built on top of: https://greasyfork.org/en/scripts/370410-pinterest-open-original-image
