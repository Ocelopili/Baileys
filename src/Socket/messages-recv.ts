
import { makeGroupsSocket } from "./groups"
import { SocketConfig, WAMessageStubType, ParticipantAction, Chat, GroupMetadata } from "../Types"
import { decodeMessageStanza, encodeBigEndian, toNumber } from "../Utils"
import { BinaryNode, jidDecode, jidEncode, isJidStatusBroadcast, areJidsSameUser, getBinaryNodeChildren } from '../WABinary'
import { downloadIfHistory } from '../Utils/history'
import { proto } from "../../WAProto"
import { generateSignalPubKey, xmppPreKey, xmppSignedPreKey } from "../Utils/signal"
import { KEY_BUNDLE_TYPE } from "../Defaults"

export const makeMessagesRecvSocket = (config: SocketConfig) => {
	const { logger } = config
	const sock = makeGroupsSocket(config)
	const { 
		ev,
        authState,
		ws,
        assertingPreKeys,
		sendNode,
	} = sock

    const sendMessageAck = async({ attrs }: BinaryNode) => {
        const isGroup = !!attrs.participant
        const { user: meUser } = jidDecode(authState.creds.me!.id!)
        const stanza: BinaryNode = {
            tag: 'ack',
            attrs: {
                class: 'receipt',
                id: attrs.id,
                to: isGroup ? attrs.from : authState.creds.me!.id,
            }
        }
        if(isGroup) {
            stanza.attrs.participant = jidEncode(meUser, 's.whatsapp.net')
        }
        await sendNode(stanza)
    }

    const sendRetryRequest = async(node: BinaryNode) => {
        const retryCount = +(node.attrs.retryCount || 0) + 1
        const isGroup = !!node.attrs.participant
        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds
        
        const deviceIdentity = proto.ADVSignedDeviceIdentity.encode(account).finish()
        await assertingPreKeys(1, async preKeys => {
            const [keyId] = Object.keys(preKeys)
            const key = preKeys[+keyId]

            const decFrom = node.attrs.from ? jidDecode(node.attrs.from) : undefined
            const receipt: BinaryNode = {
                tag: 'receipt',
                attrs: {
                    id: node.attrs.id,
                    type: 'retry',
                    to: isGroup ? node.attrs.from : jidEncode(decFrom!.user, 's.whatsapp.net', decFrom!.device, 0)
                },
                content: [
                    { 
                        tag: 'retry', 
                        attrs: { 
                            count: retryCount.toString(), id: node.attrs.id,
                            t: node.attrs.t,
                            v: '1'
                        } 
                    },
                    {
                        tag: 'registration',
                        attrs: { },
                        content: encodeBigEndian(authState.creds.registrationId)
                    }
                ]
            }
            if(node.attrs.recipient) {
                receipt.attrs.recipient = node.attrs.recipient
            }
            if(node.attrs.participant) {
                receipt.attrs.participant = node.attrs.participant
            }
            if(retryCount > 1) {
                const exec = generateSignalPubKey(Buffer.from(KEY_BUNDLE_TYPE)).slice(0, 1);

                (node.content! as BinaryNode[]).push({
                    tag: 'keys',
                    attrs: { },
                    content: [
                        { tag: 'type', attrs: { }, content: exec },
                        { tag: 'identity', attrs: { }, content: identityKey.public },
                        xmppPreKey(key, +keyId),
                        xmppSignedPreKey(signedPreKey),
                        { tag: 'device-identity', attrs: { }, content: deviceIdentity }
                    ]
                })
            }
            await sendNode(node)

            logger.info({ msgId: node.attrs.id, retryCount }, 'sent retry receipt')

            ev.emit('auth-state.update', authState)
        })
    }

    const processMessage = (message: proto.IWebMessageInfo, chatUpdate: Partial<Chat>) => {
        const protocolMsg = message.message?.protocolMessage
        if(protocolMsg) {
            switch(protocolMsg.type) {
                case proto.ProtocolMessage.ProtocolMessageType.APP_STATE_SYNC_KEY_SHARE:
                    const newKeys = JSON.parse(JSON.stringify(protocolMsg.appStateSyncKeyShare!.keys))
                    authState.creds.appStateSyncKeys = [
                        ...(authState.creds.appStateSyncKeys || []),
                        ...newKeys
                    ]
                    ev.emit('auth-state.update', authState)
                break
                case proto.ProtocolMessage.ProtocolMessageType.REVOKE:
                    ev.emit('messages.update', [
                        { 
                            key: protocolMsg.key, 
                            update: { message: null, messageStubType: 1, key: message.key } 
                        }
                    ])
                break
                case proto.ProtocolMessage.ProtocolMessageType.EPHEMERAL_SETTING:
                    chatUpdate.ephemeralSettingTimestamp = toNumber(message.messageTimestamp)
                    chatUpdate.ephemeralExpiration = protocolMsg.ephemeralExpiration
                break
            }
        } else if(message.messageStubType) {
            const meJid = authState.creds.me!.id
            const jid = message.key!.remoteJid!
            //let actor = whatsappID (message.participant)
            let participants: string[]
            const emitParticipantsUpdate = (action: ParticipantAction) => (
                ev.emit('group-participants.update', { id: jid, participants, action })
            )
            const emitGroupUpdate = (update: Partial<GroupMetadata>) => {
                ev.emit('groups.update', [ { id: jid, ...update } ])
            }

            switch (message.messageStubType) {
                case WAMessageStubType.GROUP_PARTICIPANT_LEAVE:
                case WAMessageStubType.GROUP_PARTICIPANT_REMOVE:
                    participants = message.messageStubParameters
                    emitParticipantsUpdate('remove')
                    // mark the chat read only if you left the group
                    if (participants.includes(meJid)) {
                        chatUpdate.readOnly = true
                    }
                    break
                case WAMessageStubType.GROUP_PARTICIPANT_ADD:
                case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
                case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN:
                    participants = message.messageStubParameters
                    if (participants.includes(meJid)) {
                        chatUpdate.readOnly = false
                    }
                    emitParticipantsUpdate('add')
                    break
                case WAMessageStubType.GROUP_CHANGE_ANNOUNCE:
                    const announce = message.messageStubParameters[0] === 'on' ? 'true' : 'false'
                    emitGroupUpdate({ announce })
                    break
                case WAMessageStubType.GROUP_CHANGE_RESTRICT:
                    const restrict = message.messageStubParameters[0] === 'on' ? 'true' : 'false'
                    emitGroupUpdate({ restrict })
                    break
                case WAMessageStubType.GROUP_CHANGE_SUBJECT:
                case WAMessageStubType.GROUP_CREATE:
                    chatUpdate.name = message.messageStubParameters[0]
                    emitGroupUpdate({ subject: chatUpdate.name })
                    break
            }
        }
    }

    const processHistoryMessage = (item: proto.HistorySync) => {
        switch(item.syncType) {
            case proto.HistorySync.HistorySyncHistorySyncType.INITIAL_BOOTSTRAP:
                const messages: proto.IWebMessageInfo[] = []
                const chats = item.conversations!.map(
                    c => {
                        const chat: Chat = { ...c }
                        //@ts-expect-error
                        delete chat.messages
                        for(const item of c.messages || []) {
                            messages.push(item.message)
                        }
                        return chat
                    }
                )
                ev.emit('chats.set', { chats, messages })
            break
            case proto.HistorySync.HistorySyncHistorySyncType.PUSH_NAME:
                const contacts = item.pushnames.map(
                    p => ({ notify: p.pushname, id: p.id })
                )
                ev.emit('contacts.upsert', contacts)
            break
            case proto.HistorySync.HistorySyncHistorySyncType.INITIAL_STATUS_V3:
                // TODO
            break
        }
    }

    const processNotification = (node: BinaryNode): Partial<proto.IWebMessageInfo> => {
        const result: Partial<proto.IWebMessageInfo> = { }
        const child = (node.content as BinaryNode[])?.[0]

        if(node.attrs.type === 'w:gp2') {
            switch(child?.tag) {
                case 'ephemeral':
                case 'not_ephemeral':
                    result.message = {
                        protocolMessage: {
                            type: proto.ProtocolMessage.ProtocolMessageType.EPHEMERAL_SETTING,
                            ephemeralExpiration: +(child.attrs.expiration || 0)
                        }
                    }
                    break
                case 'promote':
                case 'demote':
                case 'remove':
                case 'add':
                case 'leave':
                    const stubType = `GROUP_PARTICIPANT_${child.tag!.toUpperCase()}`
                    result.messageStubType = WAMessageStubType[stubType]
                    result.messageStubParameters = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid)
                    break
                case 'subject':
                    result.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
                    result.messageStubParameters = [ child.attrs.subject ]
                    break
                case 'announcement':
                case 'not_announcement':
                    result.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
                    result.messageStubParameters = [ (child.tag === 'announcement').toString() ]
                    break
                case 'locked':
                case 'unlocked':
                    result.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
                    result.messageStubParameters = [ (child.tag === 'locked').toString() ]
                    break
                
            }
        } else {
            switch(child.tag) {
                case 'count':
                    if(child.attrs.value === '0') {
                        logger.info('recv all pending notifications')
                        ev.emit('connection.update', { receivedPendingNotifications: true })
                    }
                break
                case 'devices':
                    const devices = getBinaryNodeChildren(child, 'device')
                    if(areJidsSameUser(child.attrs.jid, authState.creds!.me!.id)) {
                        const deviceJids = devices.map(d => d.attrs.jid)
                        logger.info({ deviceJids }, 'got my own devices')
                    }
                break
            }
        }
        if(Object.keys(result).length) {
            return result
        }
    }
    // recv a message
    ws.on('CB:message', async(stanza: BinaryNode) => {
        const dec = await decodeMessageStanza(stanza, authState)
        const fullMessages: proto.IWebMessageInfo[] = []
        for(const msg of dec.successes) {
            const { attrs } = stanza
            const isGroup = !!stanza.attrs.participant
            const sender = (attrs.participant || attrs.from)?.toString()
            const isMe = areJidsSameUser(sender, authState.creds.me!.id)
    
            await sendMessageAck(stanza)

            logger.debug({ msgId: dec.msgId, sender }, 'send message ack')

            // send delivery receipt
            let recpAttrs: { [_: string]: any }
            if(isMe) {
                recpAttrs =  {
                    type: 'sender',
                    id: stanza.attrs.id,
                    to: stanza.attrs.from,
                }
                if(isGroup) {
                    recpAttrs.participant = stanza.attrs.participant
                } else {
                    recpAttrs.recipient = stanza.attrs.recipient
                }
            } else {
                const isStatus = isJidStatusBroadcast(stanza.attrs.from)
                recpAttrs = {
                    //type: 'inactive',
                    id: stanza.attrs.id,
                    to: dec.chatId,
                }
                if(isGroup || isStatus) {
                    recpAttrs.participant = stanza.attrs.participant
                }
            }
            await sendNode({ tag: 'receipt', attrs: recpAttrs })

            logger.debug({ msgId: dec.msgId }, 'send message receipt')

            const possibleHistory = downloadIfHistory(msg)
            if(possibleHistory) {
                const history = await possibleHistory
                logger.info({ msgId: dec.msgId, type: history.syncType }, 'recv history')

                processHistoryMessage(history)
            } else {
                const message = msg.deviceSentMessage?.message || msg
                fullMessages.push({
                    key: {
                        remoteJid: dec.chatId,
                        fromMe: isMe,
                        id: dec.msgId,
                        participant: dec.participant
                    },
                    message,
                    status: isMe ? proto.WebMessageInfo.WebMessageInfoStatus.SERVER_ACK : null,
                    messageTimestamp: dec.timestamp,
                    pushName: dec.pushname
                })
            }
        }

        if(dec.successes.length) {
            ev.emit('auth-state.update', authState)
            if(fullMessages.length) {
                ev.emit(
                    'messages.upsert', 
                    { 
                        messages: fullMessages.map(m => proto.WebMessageInfo.fromObject(m)), 
                        type: stanza.attrs.offline ? 'append' : 'notify' 
                    }
                )
            }
        }
        
		for(const { error } of dec.failures) {
            logger.error(
                { msgId: dec.msgId, trace: error.stack, data: error.data }, 
                'failure in decrypting message'
            )
            await sendRetryRequest(stanza)
        }
    })

    ws.on('CB:ack,class:message', async(node: BinaryNode) => {
        await sendNode({
            tag: 'ack',
            attrs: {
                class: 'receipt',
                id: node.attrs.id,
                from: node.attrs.from
            }
        })
        logger.debug({ attrs: node.attrs }, 'sending receipt for ack')
    })

    const handleReceipt = ({ attrs, content }: BinaryNode) => {
        const sender = attrs.participant || attrs.from
        const status = attrs.type === 'read' ? proto.WebMessageInfo.WebMessageInfoStatus.READ : proto.WebMessageInfo.WebMessageInfoStatus.DELIVERY_ACK
        const ids = [attrs.id]
        if(Array.isArray(content)) {
            const items = getBinaryNodeChildren(content[0], 'item')
            ids.push(...items.map(i => i.attrs.id))
        }
        
        ev.emit('messages.update', ids.map(id => ({
            key: {
                remoteJid: attrs.from,
                id: id,
                fromMe: areJidsSameUser(sender, authState.creds.me!.id!),
                participant: attrs.participant
            },
            update: { status }
        })))
    }

    ws.on('CB:receipt,type:read', handleReceipt)
    ws.on('CB:ack,class:receipt', handleReceipt)

    ws.on('CB:notification', async(node: BinaryNode) => {
        const sendAck = async() => {
            await sendNode({
                tag: 'ack',
                attrs: {
                    class: 'notification',
                    id: node.attrs.id,
                    type: node.attrs.type,
                    to: node.attrs.from
                }
            })
            
            logger.debug({ msgId: node.attrs.id }, 'ack notification')
        }

        await sendAck()

        const msg = processNotification(node)
        if(msg) {
            const fromMe = areJidsSameUser(node.attrs.participant || node.attrs.from, authState.creds.me!.id)
            msg.key = {
                remoteJid: node.attrs.from,
                fromMe,
                participant: node.attrs.participant,
                id: node.attrs.id
            }
            msg.messageTimestamp = +node.attrs.t
            
            const fullMsg = proto.WebMessageInfo.fromObject(msg)
            ev.emit('messages.upsert', { messages: [fullMsg], type: 'append' })
        }
    })

    ev.on('messages.upsert', ({ messages }) => {
        const chat: Partial<Chat> = { id: messages[0].key.remoteJid }
        for(const msg of messages) {
            processMessage(msg, chat)
            if(!!msg.message && !msg.message!.protocolMessage) {
                chat.conversationTimestamp = toNumber(msg.messageTimestamp)
                if(!msg.key.fromMe) {
                    chat.unreadCount = (chat.unreadCount || 0) + 1
                }
            }
        }
        if(Object.keys(chat).length > 1) {
            ev.emit('chats.update', [ chat ])
        }
    })

	return sock
}