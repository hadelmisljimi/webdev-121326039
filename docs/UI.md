# UI checklist

## Layout and typography

- [x] **One spacing scale and one type scale.** Sizes come from a small set of design tokens, not from numbers typed where they were needed.
  - how I checked: Inspected CSS styles and layout tokens in `server.js` rendered page across desktop and mobile viewports.
- [x] **Responsive at 380, 768 and 1280 pixels wide.** No horizontal scrollbar, no text running under another element.
  - how I checked: Tested rendered view in browser DevTools responsive mode at 380px, 768px, and 1280px widths with no horizontal overflow.
- [x] **Nothing jumps while the page loads.** Images and cards reserve their space before their content arrives.
  - how I checked: Loaded `https://webdev-121326039.onrender.com` and verified card/form containers keep layout geometry steady during load.

## The four states, on every screen

- [x] **Loading.** Something tells the user the app is working, within about 100 ms.
  - how I checked: Checked form submit and fetch states on the UI during live requests to `https://webdev-121326039.onrender.com`.
- [x] **Empty.** The screen says what this list is for and what to do next, instead of showing nothing.
  - how I checked: Checked group list rendering when no matching groups exist, confirming instructional prompt to create or browse groups.
- [x] **Error.** A sentence a person can read. Never a raw JSON body, never a stack trace, never just "Error".
  - how I checked: Tested invalid login and full-group join (`409`) flows and verified human-readable error messages are displayed.
- [x] **Success.** The user can see that what they did took effect, without reloading the page to find out.
  - how I checked: Created a study group and joined/left a group in the UI and verified immediate state feedback on screen.

## Keyboard and accessibility

- [x] **The main flow works with the keyboard alone.** Sign in, do the core action, sign out, without touching the mouse.
  - how I checked: Navigated auth and group controls using `Tab`, `Enter`, and `Space` in the browser.
- [x] **The focused element is visible.** A `:focus-visible` outline that is not switched off.
  - how I checked: Checked keyboard focus rings on inputs and buttons in the rendered interface.
- [x] **Text contrast is at least 4.5:1.** Name the tool you measured with.
  - how I checked: Checked foreground/background contrast using browser DevTools accessibility/contrast inspection.
- [x] **Every input has a label** a screen reader reads, not just placeholder text.
  - how I checked: Inspected form `<label>` elements and `for`/`id` associations in the HTML rendered by `server.js`.
- [x] **The page has a correct `<title>` and `lang`.**
  - how I checked: Verified `<html lang="...">` and descriptive `<title>` in the served HTML document.
- [x] **Touch targets are at least 44 pixels.**
  - how I checked: Checked button and interactive control dimensions in browser DevTools at 380px width.

## The model feature

- [x] **It shows that it is thinking.** A model call is slow and a free service may have been asleep; a frozen button is the worst possible answer.
  - how I checked: Triggered recommendation requests and verified loading feedback while waiting for response.
- [x] **It shows when it failed,** and the rest of the screen still works.
  - how I checked: Verified fallback handling when provider is unavailable or API key is missing so group browsing and CRUD keep working.
- [x] **The user can tell the model's suggestion from a fact.** It is labelled as a suggestion, not presented as data the app knows.
  - how I checked: Checked recommendation output/fallback messaging to confirm AI suggestions are clearly distinguished from persisted database records.

## Decisions

- [x] **Dark mode, or a written decision not to have one.**
  - what I decided and why: Kept a clean light-first interface for Exercise 4 to match existing form/card styling and accessibility contrast checks first; dark mode can be added in a later polish iteration.

## Evidence

- Live deployment verified at `https://webdev-121326039.onrender.com` — UI states: ![Loading](./screenshots/loading.jfif), ![Error](./screenshots/error.jfif), ![Empty](./screenshots/empty.jfif), ![Success](./screenshots/success.jfif)
