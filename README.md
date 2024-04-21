# InfinitePlaceAnarchy2019 - An open source fork of https://rplace.live.

This site aims to be as similar to the april fools r/place event, where users were given a 2000x2000px canvas, allowing anyone to place a single pixel on it at a time. but we upgraded to bigger one. from this one lot of canvas can be played on this site via typing server address of your tkofficial server.

"Alone you can create something, but together, you can create something bigger" (or something like that)

**Site link: https://outfit8tsb.github.io/**
Thanks to Zekiah-A for Making original https://rplace.live.
When 2023: i was playing that masterpiece i made void disappear via my operation.
at 2024: turkey has overtook everything.
and after that: the color reset.
so that's why it was created as a fork.
message to turks who overtook everthing:
All Of You are Eliminated from My Shooooaw. Foreva. - two, tpot 11 by kyooby
 
![https://rplace.live running on firefox as of 18/4/2022](site_demo.png)

*Feel free to contribute!*

# custom canvas
To set up your own custom canvas to be played on here, 
we have made a guide at our [Manual](MANUAL.md).
we also provide the system to connect any canvas via TKOfficial.


# Development

Forks of this project should either:
- Connect to the same server, that is, wss://server.rplace.live:443
- Or use the same app, that is, https://rplace.live

This project is licensed under the GNU LGPL v3, out of goodwill we request forks are
not run commercially (That is, they should not generate more than the cost of server upkeep).

### For example,

- My app (`fork-of-a-place.tk`) connecting to `wss://server.rplace.live:443` [✅ Cool, non-commercially]
- i implemented that but it didn't WORK.

### Testing:
 - While in theory, all dependencies should be installable using `bun install` within the root directory. Some
 modules, such as skia canvas may have dependency issues using the bun package manager. It is reccomended you
 also run `npm i` to ensure all dependencies, such as n-api v6 are installed.
 - The server can be run with `bun run server.js` in the root directory of the project.
 - You can use a simple HTTP server, such as the npm static-server module to test the client with a local server. For example, `npx static-server --cors='*'`
 
For more information on the game's protocol, look to the [protocol documentation](PROTOCOL.md).

### Also see:
 - [bun vscode extension](https://marketplace.visualstudio.com/items?itemName=oven.bun-vscode)
