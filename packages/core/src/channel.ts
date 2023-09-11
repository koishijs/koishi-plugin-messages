import { Context, Logger, pick, Session, Universal } from 'koishi'
import { Message } from './message'

const logger = new Logger('chat')

export enum SyncStatus {
  SYNCING,
  SYNCED,
  FAILED,
}

export interface ChannelData {
  platform: string
  guildId: string
  channelId: string
  assignee?: string
  guildName?: string
  channelName?: string
  avatar?: string
  initial?: string
}

export class SyncChannel {
  public data: ChannelData
  public status = SyncStatus.SYNCING
  private _buffer: Universal.Message[] = []
  private _initTask: Promise<void>
  private _queueTask = Promise.resolve()

  constructor(private ctx: Context, platform: string, guildId: string, channelId: string) {
    this.data = { platform, guildId, channelId }
  }

  accept(session: Session) {
    if (!this.data.assignee) {
      this.data.assignee = session.selfId
    } else if (this.data.assignee !== session.selfId) {
      return true
    }

    if (session.channelName) {
      this.data.channelName = session.channelName
    }
  }

  async queue(session: Session) {
    if (this.accept(session)) return
    this._buffer.push(session)
    this.ensure(async () => {
      if (this.status === SyncStatus.SYNCING) {
        await this.init(session)
      }
      if (this.status === SyncStatus.SYNCED) {
        return this._queueTask = this._queueTask.then(() => this.flush())
      }
    })
  }

  async ensure<T>(callback: () => Promise<T>) {
    if (this.status === SyncStatus.FAILED) return
    if (this.ctx.messages.stopped) return
    try {
      return await callback()
    } catch (error) {
      logger.warn(error)
      this.status = SyncStatus.FAILED
    }
  }

  async syncHistory(rear: string, next?: string) {
    const { channelId, platform, assignee } = this.data
    logger.debug('channel %s from %s to %s', channelId, rear, next)
    const bot = this.ctx.bots[`${platform}:${assignee}`]
    outer: while (true) {
      const { data } = await bot.getMessageList(channelId, next)
      next = data[0].messageId
      for (const message of data.reverse()) {
        if (message.messageId === rear) {
          // eslint-disable-next-line no-labels
          break outer
        } else {
          this._buffer.unshift(message)
        }
      }
    }
    await this.flush()
  }

  async adapt(buffer: Universal.Message[]) {
    const data = buffer.map((session) => {
      return Message.adapt(session, this.data.platform, this.data.guildId)
    })
    await this.ctx.database.upsert('chat.message', data.filter(message => {
      return Date.now() - +message.timestamp < this.ctx.messages.config.maxAge
    }))
    return data
  }

  async getHistory(count: number, next?: string) {
    const { channelId, platform, assignee } = this.data
    logger.debug('channel %s get %s to %s', channelId, count, next)
    const bot = this.ctx.bots[`${platform}:${assignee}`]
    const buffer: Universal.Message[] = []
    while (true) {
      const { data } = await bot.getMessageList(channelId, next)
      buffer.push(...data)
      if (data.length === 0 || buffer.length >= count) {
        break
      }
      next = data[0].messageId
    }
    return this.adapt(buffer.reverse())
  }

  init(session?: Session) {
    return this._initTask ||= this._init(session)
  }

  private async _init(session?: Session) {
    const [[initial], [final]] = await Promise.all([
      this.ctx.database
        .select('chat.message')
        .where(pick(this.data, ['platform', 'channelId']))
        .orderBy('id', 'asc')
        .limit(1)
        .execute(),
      this.ctx.database
        .select('chat.message')
        .where(pick(this.data, ['platform', 'channelId']))
        .orderBy('id', 'desc')
        .limit(1)
        .execute(),
    ])
    if (final) {
      await this.syncHistory(final.messageId, session?.messageId)
    }
    this.status = SyncStatus.SYNCED
    this.data.initial = initial?.messageId
    this.ctx.emit('chat/channel', this)
  }

  async flush() {
    while (this._buffer.length) {
      const data = await this.adapt(this._buffer.splice(0))
      this.ctx.emit('chat/message', data, this)
    }
  }

  async getMessages(count: number): Promise<Message[]> {
    const messages = await this.ctx.database
      .select('chat.message')
      .where(pick(this.data, ['platform', 'channelId']))
      .orderBy('id', 'desc')
      .limit(count)
      .execute()
    messages.reverse()
    if (messages.length < count) {
      messages.unshift(...await this.getHistory(count - messages.length, messages[0]?.messageId))
    }
    return messages
  }
}
