# HTPC Display - Alexa skill for HTPC Companion

This is the Alexa skill that shows what is playing on your PC on an Echo Show.
It belongs to **HTPC Companion**. You only set it up once.

You do not need to download anything from this page. Amazon copies the skill
straight from here into your own Amazon account.

## Before you start

- Install HTPC Companion on your PC first (double-click `Setup.cmd`).
- In HTPC Companion, open **Settings** and fill in the **Echo Show** card.
  Then run `Setup.cmd` once more. Setup prepares a file for step 2 below.
- Use the **same Amazon account** as your Echo Show.

## Step 1 - Create the skill (about 2 minutes)

1. Open <https://developer.amazon.com/alexa/console/ask> and sign in.
   The first time, Amazon asks you to accept its developer terms. That is free.
2. Select **Create Skill**.
3. Name it `HTPC Display`. Language: **English (US)**. Select **Next**.
4. Choose **Other**, then **Custom**, then **Alexa-hosted (Node.js)**. Select **Next**.
5. On the templates page select **Import skill**.
6. Paste this link and select **Import**:

   ```
   https://github.com/mkanet/htpc-display-alexa-skill.git
   ```

7. Wait about one minute until the skill opens.

## Step 2 - Put in your own address (about 1 minute)

The skill needs to know where your PC is. Setup already wrote that into a file for you.

1. On your PC open the Start menu, then **HTPC Companion setup guide**.
2. In the guide select **Copy index.js**.
3. Back in the Amazon page open the **Code** tab and select the file `index.js`.
4. Click inside the code, press **Ctrl+A**, then **Ctrl+V**.
5. Select **Save**, then **Deploy**. Wait until it says the deployment finished.

## Step 3 - Switch the skill on for your devices

1. Open the **Build** tab. If it shows a **Build skill** button, select it and wait.
2. Open the **Test** tab.
3. At the top, change **Off** to **Development**.

## Step 4 - Create the Alexa Routine (in the Alexa app on your phone)

1. Open **More**, then **Routines**, then the plus button.
2. **When this happens**: **Smart Home**, then **HTPC Show Push Contact**, then **Opens**.
3. **Add action**: **Skills**, then **Your Skills**, then **HTPC Display**.
4. **From**: your Echo Show. Save.

`HTPC Show Push Contact` comes from the Home Assistant file that HTPC Companion
installs with its setup guide. The guide explains that part.

## Try it

Play a song in YouTube Music on your PC. Within a few seconds the Echo Show shows it.

If nothing appears: open HTPC Companion, select the gear icon, then **Check now**.

## What is in this repository

| Path | What it is |
| --- | --- |
| `lambda/index.js` | The skill's code. It contains `YOUR-ADDRESS` and `YOUR-KEY` placeholders. |
| `lambda/package.json` | The list of code libraries the skill uses. |
| `skill-package/skill.json` | The skill's settings (screen and audio support). |
| `skill-package/interactionModels/custom/en-US.json` | The words the skill understands. |
| `skill-package/assets/images/` | The skill's icon in two sizes. |
