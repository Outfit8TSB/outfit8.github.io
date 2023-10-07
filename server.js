/* eslint-disable no-process-exit */
// Legacy rplace server software, (c) BlobKat, Zekiah
// For the current server software, go to https://github.com/Zekiah-A/RplaceServer
import { promises as fs } from 'fs'
import sha256 from 'sha256'
import fsExists from 'fs.promises.exists'
import fetch from 'node-fetch'
import util from 'util'
import path from 'path'
import * as zcaptcha from './zcaptcha/server.js'
import { isUser } from 'ipapi-sync'
import { Worker } from 'worker_threads'
import cookie from 'cookie';
import { exec } from 'child_process'
import repl from 'basic-repl'
import { createContext, runInContext } from 'vm'

let BOARD, CHANGES, VOTES

let config = null
try { config = await fs.readFile('./server_config.json') }
catch (e) {
    await fs.writeFile("server_config.json", JSON.stringify({
        "SECURE": true,
        "CERT_PATH": "/etc/letsencrypt/live/path/to/fullchain.pem",
        "KEY_PATH": "/etc/letsencrypt/live/server.rplace.tk/fullchain.pem",
        "PORT": 443,
        "WIDTH": 2000,
        "HEIGHT": 2000,
        "COOLDOWN": 1000,
        "CAPTCHA": false,
        "PALETTE_SIZE": 32,
        "ORIGINS": [ "https://rplace.live", "https://rplace.tk" ],
        "PALETTE": null,
        "USE_CLOUDFLARE": true,
        "PUSH_LOCATION": "https://PUSH_USERNAME:MY_PERSONAL_ACCESS_TOKEN@github.com/MY_REPO_PATH",
        "PUSH_PLACE_PATH": "/path/to/local/git/repo",
        "LOCKED": false,
        "CHAT_WEBHOOK_URL": "",
        "MOD_WEBHOOK_URL": "",
        "CHAT_MAX_LENGTH": 400,
        "CHAT_COOLDOWN_MS": 2500,
        "PUSH_INTERVAL_MINS": 30,
        "CAPTCHA_EXPIRY_SECS": 45,
        "CAPTCHA_MIN_MS": 100, //min solvetime
        "INCLUDE_PLACER": false // pixel placer
    }, null, 4))

    console.log("Config file created, please update it before restarting the server")
    process.exit(0)
}
let { SECURE, CERT_PATH, PORT, KEY_PATH, WIDTH, HEIGHT, PALETTE_SIZE, ORIGINS, PALETTE, COOLDOWN, CAPTCHA,
    USE_CLOUDFLARE, PUSH_LOCATION, PUSH_PLACE_PATH, LOCKED, CHAT_WEBHOOK_URL, MOD_WEBHOOK_URL, CHAT_MAX_LENGTH,
    CHAT_COOLDOWN_MS, PUSH_INTERVAL_MINS, CAPTCHA_EXPIRY_SECS, CAPTCHA_MIN_MS, INCLUDE_PLACER } = JSON.parse(config)

try { BOARD = new Uint8Array(await Bun.file(path.join(PUSH_PLACE_PATH, "place")).arrayBuffer()) }
catch(e) { BOARD = new Uint8Array(WIDTH * HEIGHT) }
try { CHANGES = new Uint8Array(await Bun.file(path.join(PUSH_PLACE_PATH, "change")).arrayBuffer()) }
catch(e) { CHANGES = new Uint8Array(WIDTH * HEIGHT).fill(255) }
try { VOTES = new Uint32Array(await Bun.file('./votes').arrayBuffer()) }
catch(e) { VOTES = new Uint32Array(32) }
let uidTokenFile = Bun.file(".uidtoken")
let uidTokenName = null
if (!uidTokenFile.size) {
    uidTokenName = "UidToken_" + Math.random().toString(36).slice(2)
    await Bun.write(".uidtoken", uidTokenName)
}
else {
    uidTokenName = await uidTokenFile.text()
}

let newPos = [], newCols = [], newIds = []
let cooldowns = new Map()

const CHANGEPACKET = new DataView(new ArrayBuffer(CHANGES.length + 9))
CHANGEPACKET.setUint8(0, 2)
CHANGEPACKET.setUint32(1, WIDTH)
CHANGEPACKET.setUint32(5, HEIGHT)
const CHANGES32 = new Int32Array(CHANGES.buffer, CHANGES.byteOffset, CHANGES.byteLength >> 2)
function runLengthChanges() {
    //compress CHANGES with run-length encoding 
    let b = 9, i = 0
    while (true) {
        let c = i
        a: {
            if (i & 3) {
                if (CHANGES[i] !== 255) break a
                if (++i & 3) {
                    if (CHANGES[i] !== 255) break a
                    if (++i & 3) {
                        if (CHANGES[i] !== 255) break a
                        ++i
                    }
                }
            }
            i >>= 2; let a
            while ((a = CHANGES32[i]) === -1) i++
            i = i << 2 | (31 - Math.clz32(~a & -~a) >> 3)
        }
        if (i >= CHANGES.length) break
        c = i - c
        //c is # of blank cells
        //we will borrow 2 bits to store the blank cell count 
        //00 = no gap
        //01 = 1-byte (Gaps up to 255) 
        //10 = 2-byte (Gaps up to 65535) 
        //11 = 4-byte (idk probs never used) 
        if (c < 256) {
            if (!c) CHANGEPACKET.setUint8(b++, CHANGES[i++])
            else CHANGEPACKET.setUint16(b, (CHANGES[i++] | 64) << 8 | c), b += 2
        }
        else if (c < 65536) {
            CHANGEPACKET.setUint8(b, CHANGES[i++] | 128)
            CHANGEPACKET.setUint16(b + 1, c)
            b += 3
        }
        else CHANGEPACKET.setUint16(b, (CHANGES[i++] | 192) << 24 | c), b += 4
    }
    return new Uint8Array(CHANGEPACKET.buffer, CHANGEPACKET.byteOffset, b)
}

class DoubleMap { // Bidirectional map
    constructor() {
        this.foward = new Map()
        this.reverse = new Map()
    }

    set(key, value) {
        this.foward.set(key, value)
        this.reverse.set(value, key)
    }

    getForward(key) { return this.foward.get(key) }
    getReverse(value) { return this.reverse.get(value) }

    delete(key) {
        const value = this.foward.get(key)
        this.foward.delete(key)
        this.reverse.delete(value)
    }
    clear() { this.foward.clear(); this.reverse.clear() }
    size() { return this.foward.size }
}

class PublicPromise {
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve
            this.reject = reject
        })
    }
}

let criticalFiles = ["blacklist.txt", "webhook_url.txt", "bansheets.txt", "mutes.txt", "vip.txt", "reserved_names.txt"]
for (let i = 0; i < criticalFiles.length; i++) {
    if (!await fsExists(criticalFiles[i])) await fs.writeFile(criticalFiles[i], "", err => {
        if (err) {
            console.error(err)
            return
        }
    })
}

function randomString(length) {
    const buf = new Uint8Array(length)
    crypto.getRandomValues(buf)
    let str = ""
    for (let i = 0; i < buf.length; i++) {
        str += (buf[i].toString(16))
    }

    return str.slice(0, length)
}

let players = 0
// vip key, cooldown
let vipFile = Bun.file("./vip.txt")
if (vipFile.size == 0) {
    Bun.write("./vip.txt",
        "# VIP Key configuration file\n" +
        "# Below is the correct format of a VIP key configuration:\n" +
        "# MY_SHA256_HASHED_VIP_KEY { perms: \"canvasmod\"|\"chatmod\"|\"admin\",\"vip\", cooldownMs: N }\n\n" +
        "# Example VIP key configuration:\n" +
        "# 7eb65b1afd96609903c54851eb71fbdfb0e3bb2889b808ef62659ed5faf09963 { \"perms\": \"admin\", \"cooldownMs\": 30 }\n" +
        "# Make sure all VIP keys stored here are sha256 hashes of the real keys you hand out\n")
}
let VIP = new Map((await vipFile.text())
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith("#"))
    .map(pair => [ pair.trim().slice(0, 64), JSON.parse(pair.slice(64).trim()) ]))
let RESERVED_NAMES = new DoubleMap()
// `reserved_name private_code\n`, for example "zekiah 124215253113\n"
let reserved_lines = (await Bun.file("reserved_names.txt").text()).split('\n')
for (let pair of reserved_lines) RESERVED_NAMES.set(pair.split(" ")[0], pair.split(" ")[1])
let BLACKLISTED = new Set(
    (await Promise.all((
        (await Bun.file("bansheets.txt").text())
            .trim()
            .split('\n')
            .map(banListUrl => fetch(banListUrl).then(response => response.text())))))
    .flatMap(line => line.trim().split('\n').map(ip => ip.split(':')[0].trim())))

for (let ban of (await fs.readFile("blacklist.txt")).toString().split("\n")) {
    BLACKLISTED.add(ban)
}

let toValidate = new Map()
let captchaFailed = new Map()
const encoderUTF8 = new util.TextEncoder()
const decoderUTF8 = new util.TextDecoder()

let dbReqId = 0
const dbReqs = new Map()
const dbWorker = new Worker("./db-worker.js")
/** **Always await this**, and only use in cases where you **WANT the response**, if you want something that
 * you can just fire and forget then use dbWorker.postMessage instead */
async function makeDbRequest(message) {
    let handle = dbReqId++
    let promise = new PublicPromise()
    
    message.handle = handle
    dbReqs.set(handle, promise)
    dbWorker.postMessage(message)
    return await promise.promise
}
dbWorker.on("message", (message) => {
    dbReqs.get(message.handle)?.resolve(message.data)
})
dbWorker.on("error", console.warn)

let playerIntIds = new Map() // Player ws instance<Object> : intID<Number>
let playerChatNames = new Map() // intId<Number> : chatName<String>
let liveChatMessageId = (await makeDbRequest({ call: "getMaxLiveChatId" })) || 0
let placeChatMessageId = (await makeDbRequest({ call: "getMaxPlaceChatId" })) || 0
let mutes = new Map() // Player ws instance<Object> : EndDate
let bans = new Map() // Player ws instance<Object> : EndDate

// Server is player ID 0, all server messages have message ID 0
playerChatNames.set(0, "SERVER@RPLACE.LIVE✓")

let allowed = new Set(["rplace.tk", "rplace.live", "discord.gg", "twitter.com", "wikipedia.org", "pxls.space", "reddit.com"])
function censorText(text) {
    return text
        .replace(/(sik[ey]rim|orospu|piç|yavşak|kevaşe|ıçmak|kavat|kaltak|götveren|amcık|amcık|[fF][uU][ckr]{1,3}(\\b|ing\\b|ed\\b)?|shi[t]|c[u]nt|((n|i){1,32}((g{2,32}|q){1,32}|[gq]{2,32})[e3r]{1,32})|bastard|b[i1]tch|blowjob|clit|c[o0]ck|cunt|dick|(f[Aa4][g6](g?[oi]t)?)|jizz|lesbian|masturbat(e|ion)|nigga|卐|卍|whore|porn|pussy|r[a4]pe|slut|suck)/gi,
            match => "*".repeat(match.length))
        .replace(/https?:\/\/(\w+\.)+\w{2,15}(\/\S*)?|(\w+\.)+\w{2,15}\/\S*|(\w+\.)+(tk|ga|gg|gq|cf|ml|fun|xxx|webcam|sexy?|tube|cam|p[o]rn|adult|com|net|org|online|ru|co|info|link)/gi,
            match => allowed.has(match.replace(/^https?:\/\//, "").split("/")[0]) ? match : "")
        .trim()
}

/**
 * 
 * @param {number} type (0|1) message type (0 - Live chat message, 1 - place chat message)
 * @param {string} message Message text content (maxlen(65534))
 * @param {number} sendDate Unix epoch offset __**seconds**__ of message send
 * @param {number} messageId Message integer id (u32)
 * @param {number} intId Sender integer id (u32)
 * @param {string} channel String channel (maxlen(16))
 * @param {number} repliesTo Integer message id replies to (u32)
 * @param {number} positionIndex Index on canvas of place chat message (u32)
 * @returns {Buffer} Message packet data prepended with packet code (15)
 */
function createChatPacket(type, message, sendDate, messageId, intId, channel = null, repliesTo = null, positionIndex = null) {
    const encodedChannel = channel && encoderUTF8.encode(channel)
    const encodedTxt = encoderUTF8.encode(message)
    const msgPacket = Buffer.allocUnsafe(encodedTxt.byteLength +
        (type == 0 ? 18 + encodedChannel?.byteLength + (repliesTo == null ? 0 : 4) : 16))

    let i = 0
    msgPacket[i] = 15; i++
    msgPacket[i] = type; i++
    msgPacket.writeUInt32BE(messageId, i); i += 4
    msgPacket.writeUInt16BE(encodedTxt.byteLength, i); i += 2
    msgPacket.set(encodedTxt, i); i += encodedTxt.byteLength
    msgPacket.writeUInt32BE(intId, i); i +=  4
    
    if (type == 0) { // Live chat message
        msgPacket.writeUInt32BE(sendDate, i); i += 4
        // TODO: reactions
        msgPacket[i] = 0; i++
        // TODO: reactions
        msgPacket[i] = encodedChannel.byteLength; i++
        msgPacket.set(encodedChannel, i); i += encodedChannel.byteLength
        if (repliesTo != null) {
            msgPacket.writeUInt32BE(repliesTo, i); i += 4
        }
    }
    else { // Place (canvas chat message)
        msgPacket.writeUInt32BE(positionIndex, i); i += 4
    }

    return msgPacket
}

/**
 * 
 * @param {Map<number, string>} names IntId : String names map to be encoded
 * @returns {Buffer} Name packet data prepended with packet code (12)
 */
function createNamesPacket(names) {
    let size = 1
    let encodedNames = new Map()
    for (let [intId, name] of names) {
        let encName = encoderUTF8.encode(name)
        encodedNames.set(intId, encName)
        size += encName.length + 5
    }

    const infoBuffer = Buffer.allocUnsafe(size)
    infoBuffer[0] = 12
    let i = 1
    for (let [intId, encName] of encodedNames) {
        infoBuffer.writeUInt32BE(intId, i); i += 4
        infoBuffer.writeUInt8(encName.length, i); i++
        infoBuffer.set(encName, i); i += encName.length
    }

    return infoBuffer
}

const wss = Bun.serve({
    fetch(req, server) {
        const cookies = cookie.parse(req.headers.get("Cookie") || "")
        let newToken = null
        if (!cookies[uidTokenName]) {
            newToken = randomString(32)
        }

        let url = new URL(req.url)
        server.upgrade(req, {
            data: {
                url: url.pathname.slice(1).trim(),
                headers: req.headers,
                token: cookies[uidTokenName] || newToken
            },
            headers: {
                ...newToken && {
                    "Set-Cookie": cookie.serialize(uidTokenName,
                        newToken, { domain: url.hostname, expires: new Date(4e12),
                            httpOnly: SECURE, sameSite: SECURE ? "strict" : "none", secure: SECURE })
                }
            }
        })

        return undefined
    },
    websocket: {
        async open(ws) {
            wss.clients.add(ws)
            ws.data.ip = USE_CLOUDFLARE
                ? ws.data.headers["x-forwarded-for"].split(",").pop().split(":", 4).join(":")
                : ws.remoteAddress.split(":", 4).join(":")
            const IP = ws.data.ip
            const URL = ws.data.url
            if (!isUser(IP)) {
                ws.close()
                return
            }
            if (USE_CLOUDFLARE && !ORIGINS.includes(headers["origin"])) return ws.close()
            if (!IP || IP.startsWith("%")) return ws.close()
            if (BLACKLISTED.has(IP)) return ws.close()
            ws.subscribe("all") // receive all ws messages
            let CD = COOLDOWN
            if (URL) {
                let codeHash = sha256(URL)
                let vip = VIP.get(codeHash)
                if (!vip) {
                    return ws.close(4000, "Invalid VIP code. Please do not try again.")
                }
                ws.data.codeHash = codeHash
                ws.data.perms = vip.perms
                CD = vip.cooldownMs
            }
            ws.data.cd = CD

            if (CAPTCHA && !ws.data.perms !== "admin") await forceCaptchaSolve(ws)
            ws.data.lastChat = 0 //last chat
            ws.data.connDate = NOW //connection date
            players++

            let buf = Buffer.alloc(9)
            buf[0] = 1
            buf.writeUint32BE(Math.ceil(cooldowns.get(IP) / 1000) || 1, 1)
            buf.writeUint32BE(LOCKED ? 0xFFFFFFFF : COOLDOWN, 5)
            ws.send(buf)
            ws.send(infoBuffer)
            ws.send(runLengthChanges())
        
            // If a custom palette is defined, then we send to client
            if (Array.isArray(PALETTE)) {
                let paletteBuffer = Buffer.alloc(1 + PALETTE.length * 4)
                paletteBuffer[0] = 0
                for (let i = 0; i < PALETTE.length; i++) {
                    paletteBuffer.writeUInt32BE(PALETTE[i], i + 1)
                }
                ws.send(paletteBuffer)
            }
            
            // This section is the only potentially hot DB-related code in the server, investigate optimisatiions
            const pIntId = await makeDbRequest({ call: "authenticateUser", data: { token: ws.data.token, ip: IP } })
            ws.data.intId = pIntId
            playerIntIds.set(ws, pIntId)
            let pIdBuf = Buffer.alloc(5)
            pIdBuf.writeUInt8(11, 0) // TODO: Integrate into packet 1
            pIdBuf.writeUInt32BE(pIntId, 1)
            ws.send(pIdBuf)
        
            const pName = await makeDbRequest({ call: "getUserChatName", data: pIntId })
            if (pName) {
                ws.data.chatName = pName
                playerChatNames.set(ws.data.intId, pName)
            }
            const nmInfoBuf = createNamesPacket(playerChatNames)
            ws.send(nmInfoBuf)
        },
        async message(ws, data) {
            // Redefine as message handler is now separate from open
            const IP = ws.data.ip
            const CD = ws.data.cd

            switch (data[0]) {
                case 4: { // pixel place
                    if (data.length < 6 || LOCKED === true || toValidate.has(ws)) return
                    let i = data.readUInt32BE(1), c = data[5]
                    if (i >= BOARD.length || c >= PALETTE_SIZE) return
                    let cd = cooldowns.get(IP)
                    if (cd > NOW) {
                        let data = Buffer.alloc(10)
                        data[0] = 7
                        data.writeInt32BE(Math.ceil(cd / 1000) || 1, 1)
                        data.writeInt32BE(i, 5)
                        data[9] = CHANGES[i] == 255 ? BOARD[i] : CHANGES[i]
                        ws.send(data)
                        return
                    }
                    if (checkPreban(i % WIDTH, Math.floor(i / HEIGHT), p)) return
                    CHANGES[i] = c
                    cooldowns.set(IP, NOW + CD - 500)
                    newPos.push(i)
                    newCols.push(c)
                    if (INCLUDE_PLACER) newIds.push(ws.data.intId)
                    dbWorker.postMessage({ call: "updatePixelPlace", data: ws.data.intId })
                    break
                }
                case 12: { // Submit name
                    let name = decoderUTF8.decode(data.subarray(1))
                    let res_name = RESERVED_NAMES.getReverse(name) // reverse = valid code, use reserved name, forward = trying to use name w/out code, invalid
                    name = res_name ? res_name + "✓" : censorText(name.replace(/\W+/g, "").toLowerCase()) + (RESERVED_NAMES.getForward(name) ? "~" : "")
                    if (!name || name.length > 16) return
    
                    // Update chatNames so new players joining will also see the name and pass to DB
                    ws.data.chatName = name
                    playerChatNames.set(ws.data.intId, name)
                    dbWorker.postMessage({ call: "setUserChatName", data: { intId: ws.data.intId, newName: name }})

                    // Combine with player intId and alert all other clients of name change
                    const encName = encoderUTF8.encode(name)
                    const nmInfoBuf = Buffer.alloc(6 + encName.length)
                    nmInfoBuf.writeUInt8(12, 0)
                    nmInfoBuf.writeUInt32BE(ws.data.intId, 1)
                    nmInfoBuf.writeUInt8(encName.length, 5)
                    nmInfoBuf.set(encName, 6)
                    wss.publish("all", nmInfoBuf)
                    break
                }
                case 13: { // Live chat history
                    let messageId = data.readUint32BE(1)
                    let count = data[5] & 127
                    let before = data[5] >> 7
                    let params = []
                    let query = `
                        SELECT LiveChatMessages.*, Users.chatName AS chatName
                        FROM LiveChatMessages
                        INNER JOIN Users ON LiveChatMessages.senderIntId = Users.intId\n`
                    
                    // If messageId is 0 and we are getting before, it will return [count] most recent messages
                    if (before) {
                        messageId = Math.min(liveChatMessageId, messageId)
                        count = Math.min(liveChatMessageId, count)
                        if (messageId == 0) {
                            query += "ORDER BY messageId ASC LIMIT ?1"
                            params.push(count)
                        }
                        else {
                            query += "WHERE messageId < ?1 ORDER BY messageId ASC LIMIT ?2"
                            params.push(messageId)
                            params.push(count)
                        }
                    }
                    else { // Ater
                        count = Math.min(liveChatMessageId - messageId, count)
                        query += "WHERE messageId > ?1 ORDER BY messageId ASC LIMIT ?2"
                        params.push(messageId)
                        params.push(count)
                    }
                    let messageHistory = await makeDbRequest({ call: "exec", data: { stmt: query, params: params } })

                    const messages = []
                    const usernames = new Map()
                    let size = 6
                    for (let row of messageHistory) {
                        usernames.set(row.intId, row.chatName)
                        const messageData = createChatPacket(0, row.message, row.sendDate, row.messageId,
                            row.senderIntId, row.channel, row.repliesTo).subarray(2)
                        size += messageData.byteLength
                        messages.push(messageData)
                    }

                    // Client may race between applying intId:name bindings and inserting the new messages w/ usernames. Oof!
                    const nmInfoBuf = createNamesPacket(usernames)
                    ws.send(nmInfoBuf)
                    
                    let i = 0
                    const historyBuffer = Buffer.allocUnsafe(size)
                    historyBuffer[0] = 13; i++
                    historyBuffer.writeUInt32BE(messageId, i); i += 4
                    historyBuffer[5] = data[5]; i++
                    for (let message of messages) {
                        message.copy(historyBuffer, i, 0, message.byteLength)
                        i += message.byteLength
                    }
                    ws.send(historyBuffer)
                    break
                }
                case 15: { // chat
                    if (ws.data.lastChat + (CHAT_COOLDOWN_MS || 2500) > NOW || data.length > (CHAT_MAX_LENGTH || 400)) {
                        return
                    }
                    ws.data.lastChat = NOW
    
                    // These may or may not be defined depending on message type
                    let channel = null
                    let positionIndex = null
                    let repliesTo = null
    
                    let offset = 1
                    let type = data.readUInt8(offset++)
                    let msgLength = data.readUInt16BE(offset); offset += 2
                    let message = decoderUTF8.decode(data.subarray(offset, offset + msgLength)); offset += msgLength
                    if (type == 0) { // Live chat message
                        let channelLength = data.readUInt8(offset); offset++
                        channel = decoderUTF8.decode(data.subarray(offset, offset + channelLength)); offset += channelLength
    
                        // If the packet included a message ID it replies to, we include it
                        if (data.byteLength - offset >= 4) {
                            repliesTo = data.readUInt32BE(offset)
                        }
                    }
                    else {
                        positionIndex = data.readUint32BE(offset)
                    }
    
                    if ((type == 0 && !channel) || !message) return
                    message = censorText(message)
                    if (ws.data.perms !== "admin" && ws.data.perms !== "vip" && ws.data.perms !== "chatmod") {
                        message = message.replaceAll("@everyone", "*********")
                        message = message.replaceAll("@here", "*****")
                    }
                    else if (ws.data.perms !== "admin") {
                        message = message.replaceAll("@everyone", "*********")
                    }
                    
                    let messageId = null
                    const sendDateS = NOW / 1000
                    if (type === 0) {
                        messageId = ++liveChatMessageId
                        dbWorker.postMessage({ call: "insertLiveChat", data: [ messageId,
                            message, sendDateS, channel, ws.data.intId, repliesTo ] })
                    }
                    else {
                        messageId = ++placeChatMessageId
                        dbWorker.postMessage({ call: "insertPlaceChat", data: [ messageId,
                            message, sendDateS, ws.data.intId, Math.floor(positionIndex % WIDTH),
                            Math.floor(positionIndex / HEIGHT) ] })
                    }

                    wss.publish("all", createChatPacket(type, message, sendDateS, messageId, ws.data.intId,
                        channel, repliesTo, positionIndex))

                    if (!CHAT_WEBHOOK_URL) break
                    try {
                        const hookName = ws.data.chatName.replaceAll("@", "")
                        const hookChannel = channel.replaceAll("@", "")    
                        const hookMessage = message.replaceAll("@", "")
                        let msgHook = { username: `[${hookChannel || 'place chat'}] ${hookName} @rplace.live`, content: hookMessage }
                        fetch(CHAT_WEBHOOK_URL + "?wait=true", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msgHook) })
                    }catch (err){console.log("Could not post chat message to discord: " + err)}        
                    break
                }
                case 16: {
                    let response = data.slice(1).toString()
                    let info = toValidate.get(ws)
                    if (info && response === info.answer && info.start + CAPTCHA_EXPIRY_SECS * 1000 > NOW) {
                        captchaFailed.delete(IP)
                        toValidate.delete(ws)
                        let dv = new DataView(new ArrayBuffer(2))
                        dv.setUint8(0, 16)
                        dv.setUint8(1, 255)
                        ws.send(dv)
                    }
                    else {
                        let prev = captchaFailed.get(IP)
                        // Block bots attempting to bruteforce captcha quickly
                        if (prev && NOW - prev.last < CAPTCHA_MIN_MS) prev.fails += 3
                        let info = { fails: (prev?.fails || 0) + 1, last: NOW }
                        captchaFailed.set(IP, info)
                        let acceptableFails = Math.min(zcaptcha.config.dummiesCount / 2, 10)
                        if (info.fails < acceptableFails) return ws.close()
                        let banLengthS = (info.fails - acceptableFails + 1) ** 2 * 60
                        ban(IP, banLengthS)
                        modWebhookLog(`Client **${IP}** **banned** by server for **${banLengthS
                            }** seconds for failing captcha **${info.fails}** times`)
                    }
                    break
                }
                case 20: {
                    ws.data.voted ^= 1 << data[1]
                    if (ws.data.voted & (1 << data[1])) VOTES[data[1] & 31]++
                    else VOTES[data[1] & 31]--
                    break
                }
                case 98: { // User moderation
                    if (ws.data.perms !== "admin" || ws.data.perms !== "chatmod") return
                    let offset = 1
                    let action = data[offset++]
    
                    if (action == 0) {
                        let actionUidLen = data[offset++]
                        let actionTxt = data.slice((offset += actionUidLen)).toString()
                        let actionUid = actionTxt.slice(0, actionUidLen)
                        let actionCli = null
    
                        for(let [p, uid] of playerIntIds) {
                            if(uid === actionUid) actionCli = p
                        }
                        if (actionCli == null) return
        
                        let actionReason = actionTxt.slice(actionUidLen, actionUidLen + 300)
    
                        if (action == 0) { // kick
                            modWebhookLog(`Moderator (${ws.data.codeHash}) requested to **kick** user **${
                                actionCli.ip}**, with reason: '${actionReason}'`)
                            actionCli.close()
                        }
                    }
                    if (action == 1 || action == 2) { // mute, ban
                        let actionTimeS = data.readUInt32BE(2)
                        let actionUidLen = data[6]
                        let actionTxt = data.slice(7).toString()
                        let actionUid = actionTxt.slice(0, actionUidLen)
                        let actionCli = null
    
                        for(let [p, uid] of playerIntIds) {
                            if(uid === actionUid) actionCli = p
                        }
                        if (actionCli == null) return
    
                        let actionReason = actionTxt.slice(actionUidLen, actionUidLen + 300)
                        modWebhookLog(`Moderator (${ws.data.codeHash}) requested to **${["mute", "ban"][action - 1]
                            }** user **${actionCli.ip}**, for **${actionTimeS}** seconds, with reason: '${actionReason}'`)
    
                        if (action == 1) mute(actionCli, actionTimeS)
                        else if (action == 2) ban(actionCli)
                    }
                    if (action == 3) { // Force captcha revalidation
                        let actionUidLen = data[2]
                        let actionTxt = data.slice(3).toString()
                        let actionUid = actionTxt.slice(0, actionUidLen)
                        let actionCli = null
    
                        if (actionUidLen != 0) {
                            actionCli = null
                            for (let [p, uid] of playerIntIds) {
                                if (uid === actionUid) actionCli = p
                            }
                            if (actionCli == null) return

                            await forceCaptchaSolve(actionCli)
                        }
                        else {
                            // TODO: figure out how to iterate over all wss clients
                            for (let c of wss.clients) {
                                forceCaptchaSolve(c)
                            }
                        }
                        
                        let actionReason = actionTxt.slice(actionUidLen, actionUidLen + 300)
                        modWebhookLog(`Moderator (${ws.data.codeHash}) requested to **force captcha revalidation** for ${
                            actionUidLen == 0 ? '**__all clients__**' : ('user **' + actionCli.ip + '**')}, with reason: '${actionReason}`)
                    }
                    if (action == 4) { // Set preban
                        let x1, y1, x2, y2, violation
    
                        modWebhookLog(`Moderator (${ws.data.codeHash}) requested to **set preban area** from (${
                            x1}, ${y1}) to (${x2}, ${y2}), with violation action ${["kick", "ban", "ignore"][violation]}`)
                    }
                    break
                }
                case 99: {
                    if (ws.data.perms !== "admin" && ws.data.perms !== "canvasmod") return
                    let w = data[1], i = data.readUInt32BE(2)
                    let h = Math.floor((data.length - 6) / w)
                    if (i % WIDTH + w >= WIDTH || i + h * HEIGHT >= WIDTH * HEIGHT) return
    
                    let hi = 6
                    const target = w * h + 6
    
                    while (hi < target) {
                        CHANGES.set(data.subarray(hi, hi + w), i)
                        i += WIDTH
                        hi += w
                    }

                    modWebhookLog(`Moderator (${ws.data.codeHash}) requested to **rollback area** at (${
                        i % WIDTH}, ${Math.floor(i / WIDTH)}), ${w}x${h}px (${w * h} pixels changed)`)
                    break
                }
            }    
        },
        async close(ws, code, message) {
            players--
            playerChatNames.delete(ws.data.intId)
            playerIntIds.delete(ws)
            toValidate.delete(ws)
            dbWorker.postMessage({ call: "exec", data: {
                stmt: "UPDATE Users SET playTimeSeconds = playTimeSeconds + ?1 WHERE intId = ?2",
                params: [ Math.floor((NOW - ws.data.connDate) / 1000), ws.data.intId ] } })
            wss.clients.delete(ws)
        },
        perMessageDeflate: false,
    },
    port: PORT,
    ...SECURE && {
        tls: {
            // Path to certbot certificate, i.e: etc/letsencrypt/live/server.rplace.tk/fullchain.pem,
            // Path to certbot key, i.e: etc/letsencrypt/live/server.rplace.tk/privkey.pem
            cert: Bun.file(CERT_PATH),
            key: Bun.file(KEY_PATH)
        }
    },
})
wss.clients = new Set() // Hack for compatibility with old node code

async function modWebhookLog(message) {
    console.log(message)

    if (!MOD_WEBHOOK_URL) return
    message = message.replace("@", "@​")
    let msgHook = { username: "RPLACE SERVER", content: message }
    await fetch(MOD_WEBHOOK_URL + "?wait=true", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msgHook) })
}

let NOW = Date.now()
setInterval(() => {
    NOW = Date.now()
}, 50)

let currentCaptcha = zcaptcha.genEmojiCaptcha2

/**
 * Force a client to redo the captcha
 * @param {string|WebSocket} identifier - String client ip address or client websocket instance
*/
async function forceCaptchaSolve(identifier) {
	let cli = identifier
    if (typeof identifier === "string") {
        for (let c of wss.clients) {
            if (c.ip === identifier) cli = identifier
        }
    }
    if (!cli) return

    try {
        const result = await currentCaptcha()
        if (!result) return cli.close()
        const encodedDummies = encoderUTF8.encode(result.dummies)

        toValidate.set(cli, { start: NOW, answer: result.answer })
        let dv = new DataView(new ArrayBuffer(3 + encodedDummies.byteLength + result.data.byteLength))
        dv.setUint8(0, 16)
        dv.setUint8(1, 3)
        dv.setUint8(2, encodedDummies.byteLength)

        const dataArray = new Uint8Array(result.data)
        const dvArray = new Uint8Array(dv.buffer)
        dvArray.set(encodedDummies, 3)
        dvArray.set(dataArray, 3 + encodedDummies.byteLength)
        cli.send(dv)
    }
    catch (e) {
        console.error(e)
        cli.close()
    }
}

async function pushImage() {
    for (let i = BOARD.length - 1; i >= 0; i--) { if (CHANGES[i] != 255) BOARD[i] = CHANGES[i] }

    await Bun.write(path.join(PUSH_PLACE_PATH, "place"), BOARD)
	await fs.unlink(path.join(PUSH_PLACE_PATH, ".git/index.lock"), _ => { }).catch(_ => { })
    await new Promise((resolve, reject) =>
        exec(`cd ${PUSH_PLACE_PATH};git add -A;git commit -a -m 'Canvas backup';git push --force ${PUSH_LOCATION}`,
        error => error ? reject(error) : resolve()))

    // Serve old changes for 11 more mins just to be 100% safe of slow git sync or git provider caching
    let curr = new Uint8Array(CHANGES)
    setTimeout(() => {
        // After 11 minutes, remove all old changes. Where there is a new change, curr[i] != CHANGES[i] and so it will be kept, but otherwise, remove 
        for (let i = curr.length - 1; i >= 0; i--) { if (curr[i] == CHANGES[i]) CHANGES[i] = 255 }
    }, 200e3)
}

let captchaTick = 0
setInterval(function () {
    fs.appendFile("./pxps.txt", "\n" + newPos.length + "," + NOW)
    if (!newPos.length) return
    let pos, buf
    if (INCLUDE_PLACER) {
        buf = Buffer.alloc(1 + newPos.length * 9)
        buf[0] = 5
    }
    else {
        buf = Buffer.alloc(1 + newPos.length * 5)
        buf[0] = 6
    }
    let i = 1
    while ((pos = newPos.pop()) != undefined) {
        buf.writeInt32BE(pos, i); i += 4
        buf[i++] = newCols.pop()
        if (INCLUDE_PLACER) buf.writeInt32BE(newIds.pop(), i)
    }
    wss.publish("all", buf)

    // Captcha tick
    if (captchaTick % CAPTCHA_EXPIRY_SECS == 0) {
        for (let [c, info] of toValidate.entries()) {
            if (info.start + CAPTCHA_EXPIRY_SECS * 1000 < NOW) {
                c.close()
                toValidate.delete(c.data.ip)
            }
        }

        // How long before the server will forget their captcha fails
        for (let [ip, info] of captchaFailed.entries()) {
            if (info.last + 2 ** info.fails < NOW) captchaFailed.delete(ip)
        }
    }
    captchaTick++
}, 1000)

let pushTick = 0
let infoBuffer = Buffer.alloc(131)
infoBuffer[0] = 3
setInterval(async function () {
    pushTick++
    infoBuffer[1] = players >> 8
    infoBuffer[2] = players
    for (let i = 0; i < VOTES.length; i++) {
        infoBuffer.writeUint32BE(VOTES[i], (i << 2) + 3)
    }
    wss.publish("all", infoBuffer)

    fs.appendFile("./stats.txt", "\n" + players + "," + NOW)
    if (LOCKED === true) return
    await fs.writeFile(path.join(PUSH_PLACE_PATH, "change" + (pushTick & 1 ? "2" : "")), CHANGES)
    if (pushTick % (PUSH_INTERVAL_MINS / 5 * 60) == 0) {
        try {
            await pushImage()
            await fs.writeFile("./votes", VOTES)
        } catch (e) {
            console.log("[" + new Date().toISOString() + "] Error pushing image", e)
        }
        for (let [k, t] of cooldowns) {
            if (t > NOW) cooldowns.delete(k)
        }
    }
}, 5000)

// HACK: Issue with Bun/JSCore causes eval to not operate in the correct scope
const replExports = {
    BOARD, CHANGES, VOTES, BLACKLISTED, RESERVED_NAMES, VIP,
    SECURE, CERT_PATH, PORT, KEY_PATH, WIDTH, HEIGHT, PALETTE_SIZE, ORIGINS, PALETTE, COOLDOWN, CAPTCHA,
    USE_CLOUDFLARE, PUSH_LOCATION, PUSH_PLACE_PATH, LOCKED, CHAT_WEBHOOK_URL, MOD_WEBHOOK_URL, CHAT_MAX_LENGTH,
    CHAT_COOLDOWN_MS, PUSH_INTERVAL_MINS, CAPTCHA_EXPIRY_SECS, CAPTCHA_MIN_MS, INCLUDE_PLACER,
    dbWorker, cooldowns, toValidate, captchaFailed, playerIntIds, playerChatNames,
    liveChatMessageId, placeChatMessageId, mutes, bans, wss, zcaptcha, players,
    makeDbRequest, pushImage, currentCaptcha, forceCaptchaSolve, fill,
    setPreban, clearPreban, checkPreban, ban, mute, blacklist, announce
}
const context = createContext(replExports)
repl("|place$ ", input => console.log(runInContext(input, context)))
function fill(x, y, x1, y1, c = 27, random = false) {
    let w = x1 - x, h = y1 - y
    for (; y < y1; y++) {
        for (; x < x1; x++) {
            CHANGES[x + y * WIDTH] = random ? Math.floor(Math.random() * 24) : c
        }
        x = x1 - w
    }

    return `Filled an area of ${w}*${h} (${(w * h)} pixels), reload the game to see the effects`
}

// This function is intended to allow us to ban any contributors to a heavily botted area (most likely botters)
// by banning them as soon as we notice them placing a pixel in such area.  
const prebanArea = { x: 0, y: 0, x1: 0, y1: 0, action: "kick" } // kick, ignore, ban, or function(p, x, y): bool
function setPreban(_x, _y, _x1, _y1, _action = "kick") {
    prebanArea.x = _x; prebanArea.y = _y; prebanArea.x1 = _x1; prebanArea.y1 = _y1; prebanArea.action = _action;
}
function clearPreban() {
    prebanArea.x = 0; prebanArea.y = 0; prebanArea.x1 = 0; prebanArea.y1 = 0; prebanArea.action = "kick";
}
function checkPreban(incomingX, incomingY, p) {
    if (prebanArea.x == 0 && prebanArea.y == 0 && prebanArea.x1 == 0 && prebanArea.y1 == 0) return false
    if ((incomingX > prebanArea.x && incomingX < prebanArea.x1) && (incomingY > prebanArea.y && incomingY < prebanArea.y1)) {
        if (prebanArea.action instanceof Function) {
            return prebanArea.action(p, incomingX, incomingY)            
        }
        if (prebanArea.action == "ban") {
            ban(p.data.ip, 0xFFFFFFFF / 1000)
            return true
        }
        if (prebanArea.action == "kick") {
            p.close()
            return true
        }
        if (prebanArea.action == "ignore") {
            return true
        }

        console.log(`Pixel placed in preban area at ${incomingX},${incomingY} by ${p.ip}`)
    }

    return false
}

/**
 * Ban a client using either ip or their websocket instance
 * @param {string|WebSocket} identifier - String client ip address or client websocket instance
*/
function ban(identifier, duration, reason = null, mod = null) {
    let ip = null
    if (typeof identifier === "string") {
        ip = identifier
        for (const p of wss.clients) {
            if (p.data.ip === ip) p.close()
        }
    } else if (identifier instanceof Object) {
        const cli = identifier
        cli.close()
        ip = cli.ip
    }
    if (!ip) return

    let finish = NOW + duration * 1000
    //bans.set(ip, finish)
    //dbWorker.postMessage({ call: "insertBan", data: { uidType: "IP" } })
}

/**
 * Mute a client using either ip, their websocket instance, or their intId
 * @param {string|ServerWebSocket<any>|number} identifier - String client ip address or client websocket instance
 * @param {Number} duration - Integer duration (seconds) for however long this client will be muted for
*/
function mute(identifier, duration, reason = null, mod = null) {
    let ip = identifier
    if (typeof identifier === "number") {
        const cli = playerIntIds.get(identifier)
        if (!cli) return
        cli.close()
        ip = cli.ip
    }
    else if (identifier instanceof Object) {
        const cli = identifier
        ip = cli.ip
    }
    if (!ip) return
    
    let finish = NOW + duration * 1000
    //mutes.set(ip, finish)
    //dbWorker.postMessage("exec", { stmt: "INSERT INTO Mutes", params: [ ] })
}

/**
 * Permanment IP block a player by IP, via WS instance or via intID
 * @param {string|ServerWebSocket<any>|number} identifier IP/WS Instance/intID
 */
function blacklist(identifier) {
    let ip = null
    if (typeof identifier === "number") {
        const cli = playerIntIds.get(identifier)
        if (!cli) return
        cli.close()
        ip = cli.ip
    }
    else if (typeof identifier === "string") {
        ip = identifier
        for (const p of wss.clients) {
            if (p.data.ip === ip) p.close()
        }
    }
    else if (identifier instanceof Object) {
        const cli = identifier
        cli.close()
        ip = cli.ip
    }
    if (!ip) return

    BLACKLISTED.set(ip, Infinity)
    fs.appendFile("blacklist.txt", "\n" + ip)
}

/**
 * Broadcast a message as the server to a specific client (p) or all players, in a channel
 * @param {string} msg Message being sent
 * @param {string} channel Channel message could be sent in
 * @param {ServerWebSocket<any>} p WS instance message is being sent to
 */
function announce(msg, channel, p = null, repliesTo = null) {
    let packet = createChatPacket(0, msg, NOW / 1000, 0, 0, channel, repliesTo)
    if (p != null) p.send(packet)
    else for (let c of wss.clients) c.send(packet)
}

let shutdown = false
process.on("uncaughtException", console.warn)
process.on("SIGINT", function () {
    if (shutdown) {
        console.log("Bruh impatient")
        process.exit(0)
    }
    else {
        shutdown = true
        process.stdout.write("\rShutdown received. Wait a sec");

        (async function() {
            await makeDbRequest({ call: "commitShutdown" })
            console.log("\rBye-bye!                             ")
            process.exit(0)
        })()
    }
})