# Pictal

A browser extension based on [Imagus Reborn](https://github.com/hababr/Imagus-Reborn) that allows you to enlarge and preview images and videos from links. The rules (sieves) for supporting specific sites is fully customizable and can be modified and shared.

Fully supported on Chrome and Firefox.

Development is primarily focused on Firefox because that is what I use and the problems Imagus had on Firefox is what led me to create Pictal in the first place. If there are any issues on Chrome then I may not catch them unless reported.

# How Pictal Works

1. Everytime an element is moused over, it looks for urls in the element, its ancestors, and its cousins.
2. The gathered urls are compared to the sieves in their alphanumeric order and the first match against a **Link Regex** or **Image Regex** is used.
3. The selection outline is shown and a timer counts down based on the display delay in the options.
4. Once the timer hits 0, the loading icon is shown and the url is parsed and processed through the matched section of a sieve and then formatted into an object that Pictal can use.
5. If the loading icon turns green, it means the returned object passes all the checks and will attempt to display the image/video in the preview. If the loading icon turns red, it means that an error occured or the returned object didn't pass the checks.  

# Differences Between Pictal and Imagus

* There isn't feature parity with Imagus (yet). A lot of preferences, some shortcuts, and sieve settings are missing although if there is demand for those features then they could be added.
* The image save system uses custom workarounds to download tricky images. There is no need for Simple Modify Headers.
* There is native VideoJS support, an extension system is unneeded.
* The core of the sieve only uses javascript, there is no swapping between javascript mode and regex mode. I want this to be as simple as possible.
* The grant/site filter system only uses regex, there is no swapping between modes.
* There is no high resolution and low resolution mode, you can only choose one url.
* The APIs available to the sieves are completely different.

# Sieves

## Links

This is for general links that aren't themselves media files and links that may be media files but you want to add captions to.

### Link Regex

This determines what links you want looked for when hovering your mouse over html elements.

### Link Request Javascript

This determines the url that a GET request will be made to and have the body passed to Link Parse Javascript.
If this field is left blank then no GET request is made and the body is instead an empty string.

#### API:
- this.protocol
    - the http protocol of the url, ex. `https://` / `https://www.`
- this.link
    - the rest of the url after the protocol, ex. `mpv.io/manual/`
- this.regex
    - the RegExp object of the Link Regex
- this.regex_match
    - equivalent to `this.link.match(this.regex)`
- this.node
    - the element that your mouse is hovered over

#### Expected Return
##### URL string
    "https://old.reddit.com/by_id/t3_vt1nib.json"

### Link Parse Javascript

This is where the list of urls you want shown in the preview is created. You have to determine yourself if something is a video or not, there is no automatic checking.

#### API:
- this.protocol
- this.link
- this.regex
- this.regex_match
- this.node
- this.body
    - the text body from the GET request made to the url from Link Request Javascript, is empty if Link Request Javascript is empty
- this.passthrough
    - in the case of a loop, you may want to carry over information from the previous execution context so use this

#### Expected Return

##### Array of tables
    [
        { url: "https://i.redd.it/753dud93zbjg1.png", caption: "tigers" },
        { url: "https://fxtwitter.com/hylics/status/1531022290456088577.mp4", video: true, filename: "meme.mp4" }
        { url: "https://v.redd.it/cq4ti5ut43jg1/DASHPlaylist.mpd", video: true, videojs: true }
    ]

##### Loopback for making extra requests
    {
        loop: "https://old.reddit.com/by_id/t3_vt1nib.json",
        passthrough: "this is my caption"
    }



## Images

This is for links that are media files and links whose extension you don't know. There are no captions but you can brute force through a combination of different file extensions.

### Image Regex

This determines what links you want to be looked for when hovering your mouse on html elements.

### Image Parse Javascript

This is where you choose which url you want shown in the preview. You can use a wildcard system to check each combination for the valid link. If it has a video file extension then it is determined to be a video, if there is no valid video extension then it is determined based on its content-type.

If this field is left blank then the full url is passed to the preview as-is.

#### API:
- this.protocol
- this.link
- this.regex
- this.regex_match
- this.node


#### Expected Return
    "https://i.4cdn.org/g/1745612666469146.#jpg png mp4 webm gif#"